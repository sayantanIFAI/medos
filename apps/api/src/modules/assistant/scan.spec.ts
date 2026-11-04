import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import type { AppConfig } from "../../common/config";
import { makeUserWithPermissions, registerPatient, startApp, type TestApp, type TestTenant } from "../../test/harness";
import { OcrService, type OcrEngine, type OcrResult } from "./ocr.service";
import { PrescriptionScanService } from "./scan.service";

const PNG = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "src", "test", "fixtures", "prescription-sample.png"));

// What the remote AI host would read off the sample prescription image (a fake host stands in for it: no model runs in these tests).
const SAMPLE_TEXT = [
  "Kolkata Care Clinic", "Dr. Anita Sen, MD (Cardiology)", "Patient: Sunita Devi   Age: 54", "Investigations:",
  "1. Complete Blood Count (CBC)", "2. Lipid Profile", "3. HbA1c", "4. Thyroid Profile", "Follow up with Dr. Anita Sen after 2 weeks.",
].join("\n");
const CFG = (url: string | undefined) => ({ AI_REMOTE_URL: url, AI_REMOTE_TOKEN: "test-token-0123456789", AI_REMOTE_TIMEOUT_MS: 5000 }) as AppConfig;

class FakeOcr implements OcrEngine {
  constructor(public text: string, public confidence = 90) {}
  async readImage(): Promise<OcrResult> { return { text: this.text, confidence: this.confidence, engine: "fake" }; }
  async readPdf(): Promise<OcrResult> { return { text: this.text, confidence: 100, engine: "pdf-text" }; }
}

describe("prescription scan", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let scans: PrescriptionScanService;
  let remoteOcr: OcrService;
  let host: http.Server;
  const seen: { auth: string | undefined; type: string | undefined; url: string | undefined; bytes: number }[] = [];
  let patientId: string;
  let anita: string;

  const scan = (token: string, query: string, body: Buffer | string = PNG, type = "image/png") =>
    t.api("post", `/assistant/prescription-scan${query}`, token).set("Content-Type", type).send(body);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("scan-a");
    b = await t.makeTenant("scan-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    scans = t.app.get(PrescriptionScanService);
    host = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ auth: req.headers.authorization, type: req.headers["content-type"], url: req.url, bytes: Buffer.concat(chunks).length });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ text: SAMPLE_TEXT, confidence: 92, engine: "fake" }));
      });
    });
    await new Promise<void>((ok) => host.listen(0, "127.0.0.1", ok));
    remoteOcr = new OcrService(CFG(`http://127.0.0.1:${(host.address() as AddressInfo).port}`));
    for (const x of [
      { code: "CBC", name: "Complete Blood Count (CBC)", price: 400, aliases: ["blood count"] },
      { code: "LIP", name: "Lipid Profile", price: 650, aliases: ["cholesterol test"], fastingRequired: true },
      { code: "A1C", name: "HbA1c", price: 650, aliases: ["glycosylated haemoglobin"] },
      { code: "THY", name: "Thyroid Profile (T3 T4 TSH)", price: 700, aliases: ["thyroid", "थायराइड", "tsh"] },
      { code: "FBS", name: "Blood Sugar Fasting", price: 120, aliases: ["fbs", "sugar"] },
      { code: "PPBS", name: "Blood Sugar PP", price: 120, aliases: ["ppbs", "sugar"] },
    ]) assert.ok([200, 201].includes((await t.api("put", "/lab/tests", a.admin.token).send(x)).status));
    const dept = await t.prisma.department.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, name: "Cardiology", code: "CARDIO" } });
    for (const name of ["Dr. Anita Sen", "Dr. Anil Sen"]) {
      const p = await t.prisma.practitioner.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, departmentId: dept.id, displayName: name } });
      if (name === "Dr. Anita Sen") anita = p.id;
      const windows = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, start: "10:00", end: "12:00", slotMinutes: 15 }));
      assert.equal((await t.api("put", `/practitioners/${p.id}/schedule`, a.admin.token).send({ windows })).status, 200);
    }
    patientId = (await registerPatient(t, rec.token)).id;
  });
  after(async () => { scans.useEngine(remoteOcr); await t.close(); await new Promise((ok) => host.close(ok)); });

  it("sends the prescription to the remote AI host to be read, then books the tests and the follow-up", async () => {
    scans.useEngine(remoteOcr);
    const r = await scan(rec.token, `?patientId=${patientId}&autoBook=true&filename=rx.png`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.reading.engine, "remote-fake");
    const call = seen[seen.length - 1];
    assert.equal(call?.auth, "Bearer test-token-0123456789", "the host's token is sent");
    assert.equal(call?.type, "image/png");
    assert.equal(call?.bytes, PNG.length, "the picture itself is what is sent");
    assert.match(call?.url ?? "", /^\/ocr\?lang=hi/);
    assert.ok(d.reading.confidence >= 55, `confidence ${d.reading.confidence}`);
    assert.ok(d.reading.text.includes("Lipid Profile"));
    const names = [...d.booked.lab.tests].sort();
    assert.deepEqual(names, ["Complete Blood Count (CBC)", "HbA1c", "Lipid Profile", "Thyroid Profile (T3 T4 TSH)"]);
    assert.equal(d.booked.lab.total, "2400.00");
    assert.equal(d.booked.appointments.length, 1);
    assert.equal(d.booked.appointments[0].doctor, "Dr. Anita Sen");
    assert.ok(d.fileId);

    const lab = await t.prisma.labBooking.findFirstOrThrow({ where: { id: d.booked.lab.id } });
    assert.equal(lab.source, "PRESCRIPTION");
    assert.equal(lab.fileId, d.fileId);
    assert.equal(lab.patientId, patientId);
    const appt = await t.prisma.appointment.findFirstOrThrow({ where: { id: d.booked.appointments[0].id } });
    assert.equal(appt.source, "PRESCRIPTION");
    assert.equal(appt.practitionerId, anita);
    const days = (appt.startAt.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 12 && days < 17, `about two weeks ahead, got ${days.toFixed(1)}`);
    assert.ok(await t.prisma.patientFile.findFirst({ where: { id: d.fileId, patientId, kind: "DOCUMENT" } }));
    const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "PRESCRIPTION_SCANNED" } });
    const meta = ev.metadata as Record<string, unknown>;
    assert.equal(meta.labBooked, true);
    assert.ok(!JSON.stringify(meta).includes("Sunita"), "the prescription's text is not copied into the audit trail");
  });

  it("scanning the same prescription again books nothing twice", async () => {
    scans.useEngine(remoteOcr);
    const labs = await t.prisma.labBooking.count({ where: { tenantId: a.tenantId } });
    const appts = await t.prisma.appointment.count({ where: { tenantId: a.tenantId, source: "PRESCRIPTION" } });
    const r = await scan(rec.token, `?patientId=${patientId}&autoBook=true`);
    assert.equal(r.status, 200);
    assert.equal(await t.prisma.labBooking.count({ where: { tenantId: a.tenantId } }), labs);
    assert.equal(await t.prisma.appointment.count({ where: { tenantId: a.tenantId, source: "PRESCRIPTION" } }), appts);
  });

  it("without autoBook it only shows what it found and books and stores nothing", async () => {
    scans.useEngine(new FakeOcr("Investigations: CBC, TSH\nFollow up with Dr. Anil Sen after 1 week"));
    const labs = await t.prisma.labBooking.count({ where: { tenantId: a.tenantId } });
    const files = await t.prisma.patientFile.count({ where: { tenantId: a.tenantId } });
    const r = await scan(rec.token, "");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.tests.map((x: { name: string }) => x.name).sort(), ["Complete Blood Count (CBC)", "Thyroid Profile (T3 T4 TSH)"]);
    assert.equal(r.body.data.visits[0].doctorName, "Dr. Anil Sen");
    assert.equal(r.body.data.booked.lab, null);
    assert.equal(await t.prisma.labBooking.count({ where: { tenantId: a.tenantId } }), labs);
    assert.equal(await t.prisma.patientFile.count({ where: { tenantId: a.tenantId } }), files);
  });

  it("books only what is certain: an ambiguous test, a misspelling and an unclear follow-up go to staff", async () => {
    scans.useEngine(new FakeOcr("Blood sugar test and Lipid profle\nCBC\nFollow up after a few days"));
    const p = (await registerPatient(t, rec.token)).id;
    const r = await scan(rec.token, `?patientId=${p}&autoBook=true`);
    const d = r.body.data;
    assert.deepEqual(d.booked.lab.tests, ["Complete Blood Count (CBC)"]);
    assert.equal(d.booked.appointments.length, 0);
    const reasons = d.needsReview.map((x: { reason: string }) => x.reason).join(" | ");
    assert.match(reasons, /More than one test fits/);
    assert.match(reasons, /spelling/);
    assert.match(reasons, /Follow-up or referral found/);
  });

  it("books nothing from a blurry reading", async () => {
    scans.useEngine(new FakeOcr("CBC Lipid Profile", 30));
    const p = (await registerPatient(t, rec.token)).id;
    const r = await scan(rec.token, `?patientId=${p}&autoBook=true`);
    assert.equal(r.body.data.reading.unclear, true);
    assert.equal(r.body.data.booked.lab, null);
    assert.equal(await t.prisma.labBooking.count({ where: { tenantId: a.tenantId, patientId: p } }), 0);
    assert.match(r.body.data.needsReview[0].reason, /retake/);
  });

  it("a referral to a department books the earliest free doctor there", async () => {
    scans.useEngine(new FakeOcr("Advised: refer to Cardiologist urgently"));
    const p = (await registerPatient(t, rec.token)).id;
    const r = await scan(rec.token, `?patientId=${p}&autoBook=true`);
    assert.equal(r.body.data.booked.appointments.length, 1, JSON.stringify(r.body.data));
    const appt = await t.prisma.appointment.findFirstOrThrow({ where: { id: r.body.data.booked.appointments[0].id }, include: { practitioner: true } });
    assert.equal(appt.source, "PRESCRIPTION");
    assert.match(appt.practitioner.displayName, /Sen/);
    assert.ok(appt.startAt.getTime() - Date.now() < 3 * 86_400_000, "as soon as possible");
  });

  it("uses the user's own rights: lab booking and appointments are skipped, not forced", async () => {
    scans.useEngine(new FakeOcr("CBC\nFollow up with Dr. Anita Sen after 1 week"));
    const u = await makeUserWithPermissions(t, a, ["ASSISTANT_USE", "PATIENT_READ", "LAB_READ"]);
    const p = (await registerPatient(t, rec.token)).id;
    const r = await scan(u.token, `?patientId=${p}&autoBook=true`);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.booked.lab, null);
    assert.equal(r.body.data.booked.appointments.length, 0);
    assert.match(JSON.stringify(r.body.data.needsReview), /cannot book/);
  });

  it("says so plainly when the AI host cannot be reached, and books nothing", async () => {
    scans.useEngine(new OcrService(CFG("http://127.0.0.1:1")));
    const p = (await registerPatient(t, rec.token)).id;
    const labs = await t.prisma.labBooking.count({ where: { tenantId: a.tenantId } });
    const r = await scan(rec.token, `?patientId=${p}&autoBook=true`);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, "AI_SERVICE_UNAVAILABLE");
    assert.equal(await t.prisma.labBooking.count({ where: { tenantId: a.tenantId } }), labs);
    scans.useEngine(remoteOcr);
  });

  it("scanning the same paper for a different patient is a new booking, never a replay of the first", async () => {
    scans.useEngine(remoteOcr);
    const other = (await registerPatient(t, rec.token)).id;
    const r = await scan(rec.token, `?patientId=${other}&autoBook=true`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.data.booked.lab);
    const lab = await t.prisma.labBooking.findFirstOrThrow({ where: { id: r.body.data.booked.lab.id } });
    assert.equal(lab.patientId, other);
    assert.equal(r.body.data.booked.appointments.length, 1);
    const appt = await t.prisma.appointment.findFirstOrThrow({ where: { id: r.body.data.booked.appointments[0].id } });
    assert.equal(appt.patientId, other, "the follow-up is for this patient, not the one scanned first");
  });

  it("validates input and keeps hospitals apart", async () => {
    scans.useEngine(new FakeOcr("CBC"));
    assert.equal((await scan(rec.token, "?autoBook=true")).status, 400, "autoBook needs a patient");
    assert.equal((await scan(rec.token, "", "not an image", "text/plain")).status, 400);
    assert.equal((await t.api("post", "/assistant/prescription-scan", rec.token).set("Content-Type", "image/png").send(Buffer.from("junk-not-png"))).status, 400);
    assert.equal((await scan(rec.token, `?patientId=${patientId}&bogus=1`)).status, 400);
    assert.equal((await scan(rec.token, "?patientId=00000000-0000-4000-8000-000000000000")).status, 404);
    const recB = await t.makeUser(b, ["RECEPTIONIST"]);
    assert.equal((await scan(recB.token, `?patientId=${patientId}&autoBook=true`)).status, 404, "another hospital's patient");
    const noUse = await makeUserWithPermissions(t, a, ["PATIENT_READ"]);
    assert.equal((await scan(noUse.token, "")).status, 403);
    assert.equal((await t.api("post", "/assistant/prescription-scan").set("Content-Type", "image/png").send(PNG)).status, 401);
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5.5 * 1024 * 1024)]);
    assert.equal((await scan(rec.token, "", big)).status, 413);
  });
});
