import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerPatient, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe("lab tests and bookings", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let cashier: { id: string; token: string };
  let cbc: string;
  let sugar: string;

  const putTest = (token: string, body: Record<string, unknown>) => t.api("put", "/lab/tests", token).send(body);
  const book = (token: string, body: Record<string, unknown>, key?: string) => {
    const r = t.api("post", "/lab/bookings", token);
    if (key) r.set("Idempotency-Key", key);
    return r.send(body);
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("lab-a");
    b = await t.makeTenant("lab-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    const x = await putTest(a.admin.token, { code: "CBC", name: "Complete Blood Count (CBC)", price: 400, aliases: ["Blood Count", "खून की जांच"] });
    assert.equal(x.status, 201, JSON.stringify(x.body));
    cbc = x.body.data.id;
    const y = await putTest(a.admin.token, { code: "FBS", name: "Blood Sugar Fasting", price: "120.50", fastingRequired: true, prepEn: "Fast for 8 hours", aliases: ["fbs"] });
    sugar = y.body.data.id;
  });
  after(async () => { await t.close(); });

  it("lists the catalogue with rates as strings, searchable by name, code and alias", async () => {
    const all = await t.api("get", "/lab/tests", rec.token);
    assert.equal(all.status, 200);
    assert.equal(all.body.data.length, 2);
    assert.equal(all.body.data.find((x: { code: string }) => x.code === "FBS").price, "120.50");
    for (const q of ["blood count", "CBC", "fbs"]) {
      const r = await t.api("get", `/lab/tests?q=${encodeURIComponent(q)}`, rec.token);
      assert.ok(r.body.data.length >= 1, q);
    }
  });

  it("only an administrator can change the catalogue, and a changed price is audited", async () => {
    assert.equal((await putTest(rec.token, { code: "X1", name: "Nope", price: 1 })).status, 403);
    const again = await putTest(a.admin.token, { code: "CBC", name: "Complete Blood Count (CBC)", price: 450, aliases: ["Blood Count"] });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.price, "450.00");
    const ev = await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "LAB_TEST_UPDATED", entityId: cbc } });
    assert.deepEqual((ev?.metadata as Record<string, string>).priceFrom, "400.00");
    await putTest(a.admin.token, { code: "CBC", name: "Complete Blood Count (CBC)", price: 400, aliases: ["Blood Count", "खून की जांच"] });
  });

  it("books tests for a patient: total computed on the server, items snapshot the price, audited", async () => {
    const p = await registerPatient(t, rec.token);
    const r = await book(rec.token, { patientId: p.id, testIds: [cbc, sugar], collectionAt: inMinutes(120), homeCollection: true, notes: "Gate 2" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.totalAmount, "520.50");
    assert.equal(r.body.data.source, "MANUAL");
    assert.equal(r.body.data.mrn, p.mrn);
    assert.deepEqual(r.body.data.items.map((i: { name: string }) => i.name).sort(), ["Blood Sugar Fasting", "Complete Blood Count (CBC)"]);
    // a later price change never rewrites the booking
    await putTest(a.admin.token, { code: "FBS", name: "Blood Sugar Fasting", price: 999, aliases: ["fbs"] });
    const got = await t.api("get", `/lab/bookings/${r.body.data.id}`, rec.token);
    assert.equal(got.body.data.totalAmount, "520.50");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "LAB_BOOKED", entityId: r.body.data.id } }));
    await putTest(a.admin.token, { code: "FBS", name: "Blood Sugar Fasting", price: "120.50", aliases: ["fbs"] });
  });

  it("is idempotent for a repeated submit and rejects the same key with a different body", async () => {
    const p = await registerPatient(t, rec.token);
    const key = `k-${uniqueWord(8)}`;
    const body = { patientId: p.id, testIds: [cbc], collectionAt: inMinutes(200) };
    const first = await book(rec.token, body, key);
    const second = await book(rec.token, body, key);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.data.id, first.body.data.id);
    assert.equal(await t.prisma.labBooking.count({ where: { tenantId: a.tenantId, patientId: p.id } }), 1);
    const other = await book(rec.token, { ...body, testIds: [sugar] }, key);
    assert.equal(other.status, 422);
  });

  it("validates input strictly", async () => {
    const p = await registerPatient(t, rec.token);
    const base = { patientId: p.id, testIds: [cbc], collectionAt: inMinutes(300) };
    const bad: [string, Record<string, unknown>][] = [
      ["no tests", { ...base, testIds: [] }],
      ["non-uuid test", { ...base, testIds: ["x"] }],
      ["unknown test", { ...base, testIds: [randomUUID()] }],
      ["unknown patient", { ...base, patientId: randomUUID() }],
      ["no timezone", { ...base, collectionAt: "2030-01-01T10:00:00" }],
      ["in the past", { ...base, collectionAt: inMinutes(-600) }],
      ["unknown field", { ...base, totalAmount: 1 }],
      ["tenant injection", { ...base, tenantId: b.tenantId }],
      ["long notes", { ...base, notes: "x".repeat(301) }],
    ];
    for (const [name, body] of bad) {
      const r = await book(rec.token, body);
      assert.ok(r.status >= 400 && r.status < 500, `${name}: ${r.status}`);
    }
  });

  it("cancels once, with a reason; the database refuses any other change", async () => {
    const p = await registerPatient(t, rec.token);
    const made = await book(rec.token, { patientId: p.id, testIds: [cbc], collectionAt: inMinutes(400) });
    const id = made.body.data.id;
    assert.equal((await t.api("post", `/lab/bookings/${id}/cancel`, rec.token).send({})).status, 400);
    const c = await t.api("post", `/lab/bookings/${id}/cancel`, rec.token).send({ reason: "Patient unwell" });
    assert.equal(c.status, 200);
    assert.equal(c.body.data.status, "CANCELLED");
    assert.equal((await t.api("post", `/lab/bookings/${id}/cancel`, rec.token).send({ reason: "again" })).status, 409);
    await assert.rejects(() => t.prisma.labBooking.update({ where: { id }, data: { status: "BOOKED" } }), /transition|cannot/i);
    await assert.rejects(() => t.prisma.labBooking.update({ where: { id }, data: { totalAmount: "1.00" } }), /rewritten/i);
    await assert.rejects(() => t.prisma.labBookingItem.deleteMany({ where: { labBookingId: id } }), /not allowed|cannot|forbid|immutable|mutat/i);
  });

  it("lists by day and patient, and keeps hospitals apart", async () => {
    const p = await registerPatient(t, rec.token);
    const when = new Date(Date.now() + 3 * 86_400_000);
    const made = await book(rec.token, { patientId: p.id, testIds: [cbc, sugar], collectionAt: when.toISOString() });
    const day = new Date(when.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const list = await t.api("get", `/lab/bookings?date=${day}&patientId=${p.id}`, rec.token);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].id, made.body.data.id);
    // another hospital sees none of it and cannot use the ids
    const otherRec = await t.makeUser(b, ["RECEPTIONIST"]);
    assert.equal((await t.api("get", `/lab/bookings/${made.body.data.id}`, otherRec.token)).status, 404);
    assert.equal((await t.api("post", `/lab/bookings/${made.body.data.id}/cancel`, otherRec.token).send({ reason: "nope nope" })).status, 404);
    const foreign = await book(otherRec.token, { patientId: p.id, testIds: [cbc], collectionAt: inMinutes(500) });
    assert.equal(foreign.status, 404);
    assert.equal((await t.api("get", "/lab/tests", otherRec.token)).body.data.length, 0);
  });

  it("enforces permissions: reading needs LAB_READ, booking needs LAB_BOOK", async () => {
    const p = await registerPatient(t, rec.token);
    assert.equal((await t.api("get", "/lab/tests", cashier.token)).status, 403);
    assert.equal((await book(cashier.token, { patientId: p.id, testIds: [cbc], collectionAt: inMinutes(600) })).status, 403);
    assert.equal((await t.api("get", "/lab/tests")).status, 401);
  });
});
