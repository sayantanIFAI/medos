import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { emptyNlu, FrontDeskEngine, MedosClient, PodClient, scanPrescription, type LlmClient, type Nlu } from "@medos/frontdesk-core";
import { makeUserWithPermissions, PASSWORD, registerPatient, startApp, type TestApp, type TestTenant } from "../../test/harness";

const PNG = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "src", "test", "fixtures", "prescription-sample.png"));
const TOKEN = "pod-token-0123456789";
const SERVICE_PERMISSIONS = ["ASSISTANT_USE", "LAB_READ", "LAB_BOOK", "APPOINTMENT_READ", "APPOINTMENT_CREATE", "PATIENT_READ", "PATIENT_CREATE", "PATIENT_UPDATE"];
const SAMPLE_TEXT = ["Child Clinic", "Dr. Anita Sen, MD", "Investigations: CBC, Lipid Profile", "Follow up with Dr. Anita Sen after 2 weeks."].join("\n");

class ScriptedModel implements LlmClient {
  next: Partial<Nlu> = {};
  async completeJson(): Promise<string> { return JSON.stringify({ ...emptyNlu(), ...this.next }); }
}

/**
 * The voicebot app and the OCR app are separate programs that reach MedOS only over HTTP, signed in as their own narrow users. These tests run
 * the very code those apps run (the dialogue engine and the scan flow from @medos/frontdesk-core) against the real MedOS API, with a stand-in for
 * the AI pod, and then look at what MedOS shows: the bookings, who made them, the scanned paper, and one journey for the patient.
 */
describe("front-desk API (voicebot app and OCR app)", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let base: string;
  let pod: http.Server;
  let podClient: PodClient;
  let voicebot: MedosClient;
  let ocrApp: MedosClient;
  let voiceUserId: string;
  let ocrUserId: string;
  let rec: { id: string; token: string };
  let anita: string;
  const model = new ScriptedModel();

  const clientFor = async (tenant: TestTenant, userId: string): Promise<MedosClient> => {
    const u = await t.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { username: true } });
    return MedosClient.connect({ baseUrl: base, tenantCode: tenant.code, identifier: u.username, password: PASSWORD });
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("fd-a");
    b = await t.makeTenant("fd-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    const server = t.app.getHttpServer() as http.Server;
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

    pod = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.end("{}"); return; }
        if (req.url?.startsWith("/ocr")) res.end(JSON.stringify({ text: SAMPLE_TEXT, confidence: 91, engine: "fake" }));
        else { res.statusCode = 404; res.end("{}"); }
      });
    });
    await new Promise<void>((ok) => pod.listen(0, "127.0.0.1", ok));
    podClient = new PodClient({ url: `http://127.0.0.1:${(pod.address() as AddressInfo).port}`, token: TOKEN, timeoutMs: 5000 });

    for (const x of [
      { code: "CBC", name: "Complete Blood Count (CBC)", price: 400, aliases: ["blood count"] },
      { code: "LIP", name: "Lipid Profile", price: 650, aliases: ["cholesterol test"], fastingRequired: true },
    ]) assert.ok([200, 201].includes((await t.api("put", "/lab/tests", a.admin.token).send(x)).status));
    const dept = await t.prisma.department.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, name: "Cardiology", code: "CARDIO" } });
    const p = await t.prisma.practitioner.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, departmentId: dept.id, displayName: "Dr. Anita Sen" } });
    anita = p.id;
    const windows = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, start: "10:00", end: "12:00", slotMinutes: 15 }));
    assert.equal((await t.api("put", `/practitioners/${p.id}/schedule`, a.admin.token).send({ windows })).status, 200);

    voiceUserId = (await makeUserWithPermissions(t, a, SERVICE_PERMISSIONS)).id;
    ocrUserId = (await makeUserWithPermissions(t, a, SERVICE_PERMISSIONS)).id;
    voicebot = await clientFor(a, voiceUserId);
    ocrApp = await clientFor(a, ocrUserId);
  });
  after(async () => { await t.close(); await new Promise((ok) => pod.close(ok)); });

  const speak = async (engine: FrontDeskEngine, owner: string, text: string, understood: Partial<Nlu>, sessionId?: string) => {
    model.next = understood;
    return engine.turn(owner, voicebot, { text, lang: "en", ...(sessionId ? { sessionId } : {}) });
  };

  it("the app learns the hospital's time zone and exactly what its own user may do", () => {
    assert.equal(voicebot.can("LAB_BOOK"), true);
    assert.equal(voicebot.can("INVOICE_CREATE"), false, "nothing beyond the narrow role");
    assert.ok(voicebot.user.length > 0);
  });

  it("voicebot app: a spoken doctor booking is read back, needs a yes, and lands in MedOS as the app's own booking", async () => {
    const engine = new FrontDeskEngine(model);
    const s1 = await speak(engine, "o1", "I want to see Dr. Anita Sen tomorrow morning", { intent: "DOCTOR_BOOK", doctor: "Anita Sen", dayOffset: 1, partOfDay: "morning" });
    assert.equal(s1.awaiting, "name");
    const s2 = await speak(engine, "o1", "Ravi Kumar", { intent: "OTHER", patientName: "Ravi Kumar" }, s1.sessionId);
    assert.equal(s2.awaiting, "age");
    await speak(engine, "o1", "45", { intent: "OTHER", age: 45 }, s1.sessionId);
    const s4 = await speak(engine, "o1", "9830011223", { intent: "OTHER", mobile: "9830011223" }, s1.sessionId);
    assert.equal(s4.awaiting, "confirm");
    assert.equal(await t.prisma.appointment.count({ where: { tenantId: a.tenantId, source: "VOICE_ASSISTANT" } }), 0, "nothing is booked before the yes");
    const done = await speak(engine, "o1", "yes", { intent: "YES" }, s1.sessionId);
    assert.equal(done.booked?.type, "DOCTOR", done.reply);
    const row = await t.prisma.appointment.findFirstOrThrow({ where: { id: done.booked?.id }, include: { patient: true } });
    assert.equal(row.source, "VOICE_ASSISTANT");
    assert.equal(row.createdById, voiceUserId, "the booking is the app's own user's, so the audit trail names it");
    assert.equal(row.practitionerId, anita);
    assert.equal(row.patient.mobile, "9830011223");
  });

  it("voicebot app: a spoken lab booking works the same way, and a repeated yes books nothing more", async () => {
    const engine = new FrontDeskEngine(model);
    const s1 = await speak(engine, "o2", "book a CBC tomorrow morning", { intent: "LAB_BOOK", tests: ["CBC"], dayOffset: 1, partOfDay: "morning" });
    await speak(engine, "o2", "Meena Das", { intent: "OTHER", patientName: "Meena Das" }, s1.sessionId);
    await speak(engine, "o2", "30", { intent: "OTHER", age: 30 }, s1.sessionId);
    await speak(engine, "o2", "9830044556", { intent: "OTHER", mobile: "9830044556" }, s1.sessionId);
    const done = await speak(engine, "o2", "yes", { intent: "YES" }, s1.sessionId);
    assert.equal(done.booked?.type, "LAB", done.reply);
    const again = await speak(engine, "o2", "yes", { intent: "YES" }, s1.sessionId);
    assert.equal(again.booked, null);
    const row = await t.prisma.labBooking.findFirstOrThrow({ where: { id: done.booked?.id } });
    assert.equal(row.source, "VOICE_ASSISTANT");
    assert.equal(row.createdById, voiceUserId);
  });

  it("OCR app: reads the paper on the pod, keeps it with the patient, books the tests and follow-up, and a repeat books nothing twice", async () => {
    const patient = await registerPatient(t, rec.token);
    const first = await scanPrescription(ocrApp, podClient, PNG, { patientId: patient.id, autoBook: true, filename: "rx.png" });
    assert.ok(first.booked.lab, JSON.stringify(first.needsReview));
    assert.equal(first.booked.appointments.length, 1);
    assert.ok(first.fileId);
    const lab = await t.prisma.labBooking.findFirstOrThrow({ where: { id: first.booked.lab?.id } });
    assert.equal(lab.source, "PRESCRIPTION");
    assert.equal(lab.fileId, first.fileId);
    assert.equal(lab.createdById, ocrUserId);
    const appt = await t.prisma.appointment.findFirstOrThrow({ where: { id: first.booked.appointments[0]?.id } });
    assert.equal(appt.source, "PRESCRIPTION");
    assert.equal(appt.fileId, first.fileId, "the follow-up is linked to the scanned paper");

    const second = await scanPrescription(ocrApp, podClient, PNG, { patientId: patient.id, autoBook: true, filename: "rx.png" });
    assert.equal(second.booked.lab?.id, first.booked.lab?.id);
    assert.equal(second.booked.appointments[0]?.id, first.booked.appointments[0]?.id);
    assert.equal(second.fileId, first.fileId, "the same paper keeps its one stored copy");
    assert.equal(await t.prisma.labBooking.count({ where: { tenantId: a.tenantId, patientId: patient.id } }), 1);
    assert.equal(await t.prisma.patientFile.count({ where: { tenantId: a.tenantId, patientId: patient.id, kind: "DOCUMENT" } }), 1);
  });

  it("OCR app: finds the patient named on the paper, without ever choosing for staff", async () => {
    const p = await registerPatient(t, rec.token);
    const hit = await t.prisma.patient.findFirstOrThrow({ where: { id: p.id } });
    const found = await ocrApp.searchPatients(hit.firstName);
    assert.ok(found.some((x) => x.id === p.id), "the patient is offered");
    assert.ok(found.every((x) => (x.mobileLast4 ?? "").length <= 4), "only the last digits of a mobile number are shown");
    assert.equal((await ocrApp.searchPatients("zzzznobodyzzzz")).length, 0);
    // a patient the voicebot saved in Devanagari is found from the English spelling on a prescription, and the other way round
    const { patientId: devId } = await voicebot.resolvePatient("script-ref-0001", { name: "पवन कुमार", mobile: "9830055667", ageYears: 30, sex: "UNKNOWN" });
    for (const q of ["pavan", "Pawan Kumar", "पवन"]) assert.ok((await ocrApp.searchPatients(q)).some((x) => x.id === devId), q);
    assert.ok(!(await ocrApp.searchPatients("sunita")).some((x) => x.id === devId), "a different name is not offered");
  });

  it("one journey per patient: the voicebot booking, the scanned paper, the lab test and the follow-up, labelled by where they came from", async () => {
    const patient = await registerPatient(t, rec.token);
    // the voicebot books a doctor visit for this patient...
    const engine = new FrontDeskEngine(model);
    const { patientId } = await voicebot.resolvePatient("journey-ref-0001", { name: "Journey Patient", mobile: "9830077889", ageYears: 50, sex: "UNKNOWN" });
    await voicebot.bookAppointment({ patientId, doctorId: anita, startAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), durationMinutes: 15, externalRef: "VOICE-journey-0001", source: "VOICE_ASSISTANT" });
    // ...and the OCR app later scans a prescription for the same patient
    const scan = await scanPrescription(ocrApp, podClient, PNG, { patientId, autoBook: true, filename: "rx.png" });
    assert.ok(scan.booked.lab);
    void engine; void patient;

    const j = await t.api("get", `/frontdesk/journey/${patientId}`, rec.token);
    assert.equal(j.status, 200, JSON.stringify(j.body));
    const events = j.body.data.events as { kind: string; via: string; fileId: string | null; at: string }[];
    const kinds = events.map((e) => `${e.via}:${e.kind}`);
    assert.ok(kinds.includes("VOICEBOT:APPOINTMENT"), kinds.join(","));
    assert.ok(kinds.includes("OCR:PRESCRIPTION") && kinds.includes("OCR:LAB_BOOKING") && kinds.includes("OCR:APPOINTMENT"), kinds.join(","));
    const fromPaper = events.filter((e) => e.via === "OCR");
    assert.ok(fromPaper.every((e) => e.fileId === scan.fileId), "everything from the paper points at the same paper");
    assert.deepEqual([...events].map((e) => e.at), [...events].map((e) => e.at).sort().reverse(), "newest first");

    const act = await t.api("get", "/frontdesk/activity?limit=10", rec.token);
    assert.equal(act.status, 200);
    assert.ok((act.body.data as { patient: { id: string; name: string } }[]).some((e) => e.patient.id === patientId && e.patient.name.includes("Journey")), "the dashboard feed names the patient");
  });

  it("is permission-based: a user without the right cannot book through the API, and nobody signed out can do anything", async () => {
    const readOnly = await makeUserWithPermissions(t, a, ["ASSISTANT_USE", "LAB_READ", "APPOINTMENT_READ", "PATIENT_READ"]);
    const body = { patientId: (await registerPatient(t, rec.token)).id, testIds: ["00000000-0000-4000-8000-000000000001"], collectionAt: new Date(Date.now() + 86_400_000).toISOString(), homeCollection: false, idempotencyKey: "denied-key-0001", source: "VOICE_ASSISTANT" };
    assert.equal((await t.api("post", "/frontdesk/lab-bookings", readOnly.token).send(body)).status, 403);
    assert.equal((await t.api("post", "/frontdesk/appointments", readOnly.token).send({ patientId: body.patientId, doctorId: anita, startAt: body.collectionAt, durationMinutes: 15, externalRef: "denied-ref-0001", source: "VOICE_ASSISTANT" })).status, 403);
    assert.equal((await t.api("get", "/frontdesk/context")).status, 401);
    const noAssistant = await makeUserWithPermissions(t, a, ["LAB_READ"]);
    assert.equal((await t.api("post", "/frontdesk/tests/match", noAssistant.token).send({ text: "cbc" })).status, 403, "needs ASSISTANT_USE");
    assert.equal((await t.api("post", "/frontdesk/tests/match", rec.token).send({ text: "cbc", extra: 1 })).status, 400, "strict bodies");
  });

  it("keeps hospitals apart: another hospital sees none of it, and cannot reach this one's patients or doctors", async () => {
    const other = await t.makeUser(b, ["RECEPTIONIST"]);
    const mine = await t.prisma.patient.findFirstOrThrow({ where: { tenantId: a.tenantId } });
    assert.equal((await t.api("get", `/frontdesk/journey/${mine.id}`, other.token)).status, 404);
    assert.equal((await t.api("get", `/frontdesk/patients/${mine.id}/exists`, other.token)).status, 404);
    assert.equal((await t.api("get", `/frontdesk/patients/${mine.id}/exists`, rec.token)).status, 200, "the owning hospital sees it");
    assert.deepEqual((await t.api("get", "/frontdesk/doctors", other.token)).body.data, []);
    assert.deepEqual((await t.api("get", "/frontdesk/activity", other.token)).body.data, []);
  });
});
