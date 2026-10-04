import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startApp, type TestApp, type TestTenant } from "../../test/harness";
import { NumberingService } from "./numbering.service";

describe("number sequence engine", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let numbering: NumberingService;
  const next = (tenant: TestTenant, type: Parameters<NumberingService["next"]>[3], facilityId = tenant.facilityId, at?: Date) =>
    t.prisma.$transaction((tx) => numbering.next(tx, tenant.tenantId, facilityId, type, at));

  before(async () => {
    t = await startApp();
    numbering = t.app.get(NumberingService);
    a = await t.makeTenant("seq-a");
    b = await t.makeTenant("seq-b");
  });
  after(async () => { await t.close(); });

  it("formats numbers from the configured pattern, padding and facility code", async () => {
    const f = await t.prisma.facility.findFirstOrThrow({ where: { id: a.facilityId } });
    assert.equal(await next(a, "MRN"), `${f.code}-000001`);
    assert.equal(await next(a, "MRN"), `${f.code}-000002`);
    const year = new Date().getFullYear();
    assert.equal(await next(a, "INVOICE"), `INV-${year}-000001`);
  });

  it("generates unique, gap-free numbers under heavy parallel load", async () => {
    const N = 60;
    const results = await Promise.all(Array.from({ length: N }, () => next(a, "RECEIPT")));
    assert.equal(new Set(results).size, N, "no duplicates");
    const seqs = results.map((r) => Number(r.split("-").pop())).sort((x, y) => x - y);
    assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1));
  });

  it("rolls the number back with its transaction (no gaps from failed work)", async () => {
    await assert.rejects(() => t.prisma.$transaction(async (tx) => {
      await numbering.next(tx, a.tenantId, a.facilityId, "PRESCRIPTION");
      throw new Error("simulated business failure");
    }));
    const n = await next(a, "PRESCRIPTION");
    assert.ok(n.endsWith("-000001"), n);
  });

  it("keeps counters independent per tenant, per facility and per type", async () => {
    const x = await next(b, "ADMISSION");
    const y = await next(a, "ADMISSION");
    const z = await next(a, "ADMISSION", a.facility2Id);
    for (const v of [x, y, z]) assert.ok(v.endsWith("-000001"), v);
    assert.ok((await next(a, "OPD_VISIT")).endsWith("-000001"));
  });

  it("resets yearly sequences at the facility's local new year (Asia/Kolkata)", async () => {
    const lateDec = new Date("2026-12-31T17:00:00Z"); // 22:30 IST, still 2026
    const newYearIst = new Date("2026-12-31T19:00:00Z"); // 00:30 IST on 1 Jan 2027
    const a1 = await next(a, "CREDIT_NOTE", a.facilityId, lateDec);
    const a2 = await next(a, "CREDIT_NOTE", a.facilityId, newYearIst);
    const a3 = await next(a, "CREDIT_NOTE", a.facilityId, newYearIst);
    assert.equal(a1, "CN-2026-000001");
    assert.equal(a2, "CN-2027-000001");
    assert.equal(a3, "CN-2027-000002");
  });

  it("rejects an unknown facility without leaking whether it exists in another tenant", async () => {
    await assert.rejects(() => next(a, "MRN", b.facilityId), (e: unknown) => (e as { code?: string }).code === "FACILITY_NOT_FOUND");
  });

  it("admin can view and change the pattern; changes apply to future numbers and are audited", async () => {
    const list = await t.api("get", "/number-sequences", a.admin.token);
    assert.equal(list.status, 200);
    assert.ok(list.body.data.find((s: { type: string }) => s.type === "MRN"));
    const put = await t.api("put", "/number-sequences/EMPTYTYPE", a.admin.token).send({ pattern: "X-{SEQ}", padding: 4, resetPolicy: "NEVER" });
    assert.equal(put.status, 404);
    const ok = await t.api("put", "/number-sequences/PURCHASE", a.admin.token).send({ pattern: "PO/{FACILITY}/{YEAR}/{SEQ}", padding: 4, resetPolicy: "YEARLY" });
    assert.equal(ok.status, 200);
    const f = await t.prisma.facility.findFirstOrThrow({ where: { id: a.facilityId } });
    assert.match(await next(a, "PURCHASE"), new RegExp(`^PO/${f.code}/\\d{4}/0001$`));
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "NUMBER_SEQUENCE_CONFIG_CHANGED" } }));
  });

  it("rejects unsafe or collision-prone configurations", async () => {
    const bad = [
      { pattern: "NOSEQ-{YEAR}", padding: 6, resetPolicy: "YEARLY" },
      { pattern: "INV-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
      { pattern: "INV-{BOGUS}-{SEQ}", padding: 6, resetPolicy: "NEVER" },
      { pattern: "INV-{SEQ}-<script>", padding: 6, resetPolicy: "NEVER" },
      { pattern: "INV-{SEQ}", padding: 0, resetPolicy: "NEVER" },
      { pattern: "INV-{SEQ}", padding: 13, resetPolicy: "NEVER" },
    ];
    for (const body of bad) assert.equal((await t.api("put", "/number-sequences/INVOICE", a.admin.token).send(body)).status, 400, JSON.stringify(body));
  });

  it("only administrators with settings permission can configure sequences", async () => {
    const cashier = await t.makeUser(a, ["CASHIER"]);
    assert.equal((await t.api("put", "/number-sequences/INVOICE", cashier.token).send({ pattern: "I-{SEQ}", padding: 6, resetPolicy: "NEVER" })).status, 403);
  });

  it("the database refuses negative counters", async () => {
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "NumberSequence" SET "lastValue" = -1 WHERE "tenantId" = ${a.tenantId}::uuid`);
  });
});
