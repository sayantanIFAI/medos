import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const ymd = (plusDays: number) => new Date(Date.now() + plusDays * 86_400_000).toISOString().slice(0, 10);
const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;

describe("operational reports", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let cashier: { id: string; token: string };
  let pharm: { id: string; token: string };
  let d1: TestDoctor;
  let d2: TestDoctor;

  const rep = (path: string, tok = a.admin.token, query: Record<string, string> = {}) => t.api("get", `/reports/${path}`, tok).query(query);
  const data = async (path: string, tok = a.admin.token, query: Record<string, string> = {}) => {
    const r = await rep(path, tok, query);
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
    return r.body.data;
  };
  const key = () => `k-${randomUUID().slice(0, 18)}`;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("rep-a");
    b = await t.makeTenant("rep-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    pharm = await t.makeUser(a, ["PHARMACIST"]);
    d1 = await makeDoctor(t, a);
    d2 = await makeDoctor(t, a);
  });
  after(async () => { await t.close(); });

  it("OPD counts per day, per doctor and per department", async () => {
    for (let i = 0; i < 3; i++) await startVisit(t, rec.token, d1, (await registerPatient(t, rec.token)).id);
    await startVisit(t, rec.token, d2, (await registerPatient(t, rec.token)).id);
    const daily = await data("opd/daily");
    assert.equal(daily.total, 4);
    assert.equal(daily.days.length, 1);
    const byDoc = await data("opd/by-doctor");
    assert.equal(byDoc.rows.find((r: { practitionerId: string }) => r.practitionerId === d1.practitionerId).visits, 3);
    assert.equal(byDoc.rows.find((r: { practitionerId: string }) => r.practitionerId === d2.practitionerId).visits, 1);
    const byDept = await data("opd/by-department");
    assert.equal(byDept.rows.find((r: { departmentId: string }) => r.departmentId === d1.departmentId).visits, 3);
    const none = await data("opd/daily", a.admin.token, { from: "2020-01-01", to: "2020-01-03" });
    assert.equal(none.total, 0);
  });

  it("collections, payment modes, cashier shift and outstanding invoices reconcile to the payments taken", async () => {
    const mk = async (amount: string) => {
      const p = await registerPatient(t, rec.token);
      const d = await t.api("post", "/invoices", cashier.token).send({ patientId: p.id, lines: [{ description: "Procedure", unitPrice: amount, taxPercent: 0, quantity: 1 }] });
      assert.equal(d.status, 201, JSON.stringify(d.body));
      assert.equal((await t.api("post", `/invoices/${d.body.data.id}/issue`, cashier.token)).status, 200);
      return d.body.data.id as string;
    };
    const paid = await mk("250");
    const unpaid = await mk("300");
    assert.equal((await t.api("post", "/shifts/open", cashier.token).send({ openingCash: "100" })).status, 201);
    const pay = await t.api("post", `/invoices/${paid}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount: "100" }, { method: "UPI", amount: "150", reference: "UPI-REP-1" }] });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));

    const c = await data("collections");
    assert.equal(c.totals.received, "250.00");
    assert.equal(c.totals.net, "250.00");
    assert.equal(c.byMode.find((m: { method: string }) => m.method === "CASH").received, "100.00");
    assert.equal(c.byMode.find((m: { method: string }) => m.method === "UPI").received, "150.00");
    assert.equal(c.days.length, 1);

    const s = await data("cashier-shifts");
    assert.equal(s.rows.length, 1);
    assert.equal(s.rows[0].receipts, "250.00");
    assert.equal(s.rows[0].cashReceived, "100.00");
    assert.equal(s.rows[0].status, "OPEN");

    const o = await data("outstanding-invoices");
    assert.equal(o.total, 1);
    assert.equal(o.items[0].id, unpaid);
    assert.equal(o.items[0].balanceDue, "300.00");
    assert.equal(o.totalDue, "300.00");
  });

  it("IPD reports: current admissions, admissions/discharges and bed occupancy", async () => {
    const mk = async (path: string, body: Record<string, unknown>) => (await t.api("post", path, a.admin.token).send(body)).body.data as { id: string };
    const ward = await mk("/wards", { name: `Ward ${uniqueWord(4)}`, code: code("W") });
    const room = await mk("/rooms", { wardId: ward.id, name: "Room", code: code("R") });
    const bed1 = await mk("/beds", { roomId: room.id, code: code("B"), dailyRate: "500" });
    await mk("/beds", { roomId: room.id, code: code("B"), dailyRate: "500" });
    const p = await registerPatient(t, rec.token);
    const adm = await t.api("post", "/admissions", rec.token).send({ patientId: p.id, consultantId: d1.practitionerId, bedId: bed1.id, reason: "Pneumonia needing IV antibiotics" });
    assert.equal(adm.status, 201, JSON.stringify(adm.body));
    const cur = await data("ipd/current-admissions");
    assert.equal(cur.total, 1);
    assert.equal(cur.rows[0].admissionNumber, adm.body.data.admissionNumber);
    assert.equal(cur.rows[0].bed.length > 0, true);
    const occ = await data("ipd/bed-occupancy");
    const w = occ.wards.find((x: { wardId: string }) => x.wardId === ward.id);
    assert.deepEqual([w.total, w.occupied, w.available, w.occupancyPercent], [2, 1, 1, 50]);
    const ad = await data("ipd/admissions-discharges");
    assert.equal(ad.totalAdmissions, 1);
    assert.equal(ad.totalDischarges, 0);
  });

  it("pharmacy reports: sales net of returns, stock, low stock and near expiry", async () => {
    const mkMed = async (reorderLevel: number) => (await t.api("post", "/medicines", pharm.token).send({ brandName: `Brand${uniqueWord(6)}`, genericName: `Gen${uniqueWord(6)}`, strength: "500 mg", dosageForm: "TABLET", gstPercent: 12, reorderLevel })).body.data as { id: string };
    const batch = async (medicineId: string, qty: number, expiry: string) => {
      const r = await t.api("post", "/pharmacy/batches", pharm.token).set("Idempotency-Key", key()).send({ medicineId, batchNo: code("BN"), expiryDate: expiry, mrp: "10.00", purchasePrice: "6.00", sellingPrice: "9.50", quantity: qty });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.data as { id: string };
    };
    const big = await mkMed(5);
    const small = await mkMed(5);
    await batch(big.id, 10, ymd(365));
    await batch(small.id, 4, ymd(30));
    const p = await registerPatient(t, rec.token);
    const d = await t.api("post", "/pharmacy/dispenses", pharm.token).set("Idempotency-Key", key()).send({ patientId: p.id, items: [{ medicineId: big.id, quantity: 3 }] });
    assert.equal(d.status, 201, JSON.stringify(d.body));

    const sales = await data("pharmacy/sales", pharm.token);
    assert.equal(sales.totals.gross, "28.50");
    assert.equal(sales.totals.net, "28.50");
    assert.equal(sales.topMedicines[0].medicineId, big.id);
    assert.equal(sales.topMedicines[0].quantity, 3);

    const stock = await data("pharmacy/stock", pharm.token);
    assert.equal(stock.rows.find((r: { medicineId: string }) => r.medicineId === big.id).quantity, 7);
    assert.equal(stock.rows.find((r: { medicineId: string }) => r.medicineId === small.id).value, "24.00");

    const low = await data("pharmacy/low-stock", pharm.token);
    assert.deepEqual(low.rows.map((r: { medicineId: string }) => r.medicineId), [small.id]);

    const exp = await data("pharmacy/near-expiry", pharm.token, { withinDays: "60" });
    assert.equal(exp.rows.length, 1);
    assert.equal(exp.rows[0].quantity, 4);
    assert.equal(exp.rows[0].expired, false);
    assert.equal((await data("pharmacy/near-expiry", pharm.token, { withinDays: "7" })).rows.length, 0);
  });

  it("rejects bad ranges and unknown parameters", async () => {
    assert.equal((await rep("opd/daily", a.admin.token, { from: "2026-02-10", to: "2026-02-01" })).status, 400);
    assert.equal((await rep("opd/daily", a.admin.token, { from: "2025-01-01", to: "2026-01-01" })).status, 400);
    assert.equal((await rep("opd/daily", a.admin.token, { from: "2026-02-31" })).status, 400);
    assert.equal((await rep("opd/daily", a.admin.token, { from: "yesterday" })).status, 400);
    assert.equal((await rep("opd/daily", a.admin.token, { tenantId: b.tenantId })).status, 400);
    assert.equal((await rep("pharmacy/near-expiry", a.admin.token, { withinDays: "0" })).status, 400);
  });

  it("is isolated by tenant and gated by permission, authentication and feature flags", async () => {
    const other = await data("opd/daily", b.admin.token);
    assert.equal(other.total, 0);
    assert.equal((await data("collections", b.admin.token)).totals.received, "0.00");
    assert.equal((await data("ipd/current-admissions", b.admin.token)).total, 0);
    assert.equal((await data("outstanding-invoices", b.admin.token)).total, 0);
    assert.equal((await rep("opd/daily", rec.token)).status, 403, "receptionist has no report access");
    assert.equal((await rep("pharmacy/stock", cashier.token)).status, 403);
    assert.equal((await t.api("get", "/reports/opd/daily")).status, 401);
    assert.equal((await t.api("put", "/settings/PHARMACY_ENABLED", b.admin.token).send({ value: false })).status, 200);
    assert.equal((await rep("pharmacy/stock", b.admin.token)).status, 403);
    assert.equal((await rep("opd/daily", b.admin.token)).status, 200, "non-module reports stay available");
  });
});
