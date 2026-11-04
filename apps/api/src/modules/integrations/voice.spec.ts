import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { randomMobile, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";

/** A local (Asia/Kolkata) time of day `d` days ahead, as an instant. */
const inDays = (d: number, hour = 10, minute = 0) => {
  const t = new Date(Date.now() + d * 86_400_000);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 0, hour * 60 + minute - 330)).toISOString();
};
let slotCounter = 0;
/** A fresh 10-minute slot (20+ days ahead) for every call, so one test never overlaps another's booking. */
const nextSlot = () => { slotCounter += 1; return inDays(20 + Math.floor(slotCounter / 40), 9 + Math.floor((slotCounter % 40) / 6), (slotCounter % 6) * 10); };
const ref = (p: string) => `${p}-${randomBytes(4).toString("hex").toUpperCase()}`;

describe("voice bot bridge", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let bot: { id: string; token: string };
  let botB: { id: string; token: string };
  let rec: { id: string; token: string };
  const doctorRef = ref("DOC");

  const putDoctor = (token: string, r: string, body: Record<string, unknown>) => t.api("put", `/integrations/voice/doctors/${r}`, token).send(body);
  const putBooking = (token: string, r: string, body: Record<string, unknown>) => t.api("put", `/integrations/voice/bookings/${r}`, token).send(body);
  const doctorBody = (o: Record<string, unknown> = {}) => ({
    name: "Dr. Sourav Mukherjee", department: "General Medicine",
    schedule: { windows: [{ dayOfWeek: 1, start: "10:00", end: "12:00", slotMinutes: 10 }] }, ...o,
  });
  const bookingBody = (o: Record<string, unknown> = {}) => ({
    status: "CONFIRMED", doctorRef, startAt: nextSlot(), durationMinutes: 10,
    patient: { name: `${uniqueWord(5)} ${uniqueWord(6)}`, mobile: randomMobile(), ageYears: 41, sex: "FEMALE", address: "Behala, Kolkata" }, ...o,
  });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("voice-a");
    b = await t.makeTenant("voice-b");
    bot = await t.makeUser(a, ["VOICE_BOT"]);
    botB = await t.makeUser(b, ["VOICE_BOT"]);
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    const d = await putDoctor(bot.token, doctorRef, doctorBody());
    assert.equal(d.status, 201, JSON.stringify(d.body));
  });
  after(async () => { await t.close(); });

  it("syncs a doctor once, creates the department, and leaves a second identical sync untouched", async () => {
    const again = await putDoctor(bot.token, doctorRef, doctorBody({ department: "general medicine" }));
    assert.equal(again.status, 200);
    assert.equal(again.body.data.created, false);
    assert.equal(again.body.data.scheduleChanged, false);
    const depts = await t.prisma.department.findMany({ where: { tenantId: a.tenantId, name: { equals: "General Medicine", mode: "insensitive" } } });
    assert.equal(depts.length, 1);
    const changed = await putDoctor(bot.token, doctorRef, doctorBody({ schedule: { windows: [{ dayOfWeek: 2, start: "09:00", end: "11:00", slotMinutes: 10 }] } }));
    assert.equal(changed.body.data.scheduleChanged, true);
    await putDoctor(bot.token, doctorRef, doctorBody()); // restore
  });

  it("accepts the short numeric doctor ids the clinic system really uses", async () => {
    const d = await putDoctor(bot.token, "1", doctorBody({ name: "Dr. Short Id" }));
    assert.equal(d.status, 201, JSON.stringify(d.body));
    const r = await putBooking(bot.token, ref("KCD"), bookingBody({ doctorRef: "1" }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.appointment.practitionerName, "Dr. Short Id");
  });

  it("finds the doctor by name when only the name is known, and refuses an ambiguous or unknown name", async () => {
    const name = `Dr. ${uniqueWord(6)} ${uniqueWord(7)}`;
    await putDoctor(bot.token, ref("DOC"), doctorBody({ name }));
    const ok = await putBooking(bot.token, ref("KCD"), bookingBody({ doctorRef: undefined, doctorName: name.toUpperCase() }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.appointment.practitionerName, name);
    await putDoctor(bot.token, ref("DOC"), doctorBody({ name })); // a second doctor with the same name
    const twice = await putBooking(bot.token, ref("KCD"), bookingBody({ doctorRef: undefined, doctorName: name }));
    assert.equal(twice.status, 422);
    assert.equal(twice.body.error.code, "DOCTOR_NOT_MAPPED");
    const none = await putBooking(bot.token, ref("KCD"), bookingBody({ doctorRef: undefined, doctorName: "Dr. Nobody At All" }));
    assert.equal(none.status, 422);
    const neither = await putBooking(bot.token, ref("KCD"), bookingBody({ doctorRef: undefined }));
    assert.equal(neither.status, 400);
  });

  it("records a booking the voice bot confirmed: new patient, appointment tagged VOICE_BOT, audited", async () => {
    const r = ref("KCD");
    const body = bookingBody();
    const res = await putBooking(bot.token, r, body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.outcome, "created");
    assert.equal(res.body.data.appointment.source, "VOICE_BOT");
    assert.equal(res.body.data.appointment.status, "BOOKED");
    assert.equal(res.body.data.appointment.practitionerName, "Dr. Sourav Mukherjee");
    const row = await t.prisma.appointment.findFirstOrThrow({ where: { tenantId: a.tenantId, externalRef: r } });
    assert.equal(row.tenantId, a.tenantId);
    assert.equal(row.endAt.getTime() - row.startAt.getTime(), 10 * 60_000);
    const patient = await t.prisma.patient.findFirstOrThrow({ where: { id: row.patientId } });
    assert.equal(patient.estimatedAgeYears, 41);
    assert.equal(patient.gender, "FEMALE");
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "APPOINTMENT_CREATED", entityId: row.id } }));
  });

  it("is idempotent: replaying the same confirmation never books or registers twice", async () => {
    const r = ref("KCD");
    const body = bookingBody();
    const first = await putBooking(bot.token, r, body);
    const second = await putBooking(bot.token, r, body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.data.outcome, "unchanged");
    assert.equal(second.body.data.appointment.id, first.body.data.appointment.id);
    assert.equal(await t.prisma.appointment.count({ where: { tenantId: a.tenantId, externalRef: r } }), 1);
    const mobile = (body.patient as { mobile: string }).mobile;
    assert.equal(await t.prisma.patient.count({ where: { tenantId: a.tenantId, mobile } }), 1);
  });

  it("reuses the patient when the same person calls again, never merging a different one", async () => {
    const mobile = randomMobile();
    const first = await putBooking(bot.token, ref("KCD"), bookingBody({ startAt: nextSlot(), patient: { name: "Anita Roy", mobile, ageYears: 33, sex: "FEMALE" } }));
    const same = await putBooking(bot.token, ref("KCD"), bookingBody({ startAt: nextSlot(), patient: { name: "Anita Roy", mobile, ageYears: 33 } }));
    assert.equal(same.body.data.patientMatched, true);
    assert.equal(same.body.data.appointment.patientId, first.body.data.appointment.patientId);
    // same family phone, different person: a NEW patient, with the duplicate override recorded for reception
    const other = await putBooking(bot.token, ref("KCD"), bookingBody({ startAt: nextSlot(), patient: { name: "Biplab Sen", mobile, ageYears: 8, sex: "MALE" } }));
    assert.equal(other.status, 201, JSON.stringify(other.body));
    assert.notEqual(other.body.data.appointment.patientId, first.body.data.appointment.patientId);
    assert.equal(await t.prisma.patient.count({ where: { tenantId: a.tenantId, mobile } }), 2);
  });

  it("asks for reception's help, not a guess, when a new caller's age is missing or the doctor is unknown", async () => {
    const noAge = await putBooking(bot.token, ref("KCD"), bookingBody({ patient: { name: "No Age", mobile: randomMobile() } }));
    assert.equal(noAge.status, 422);
    assert.equal(noAge.body.error.code, "PATIENT_AGE_REQUIRED");
    const unknown = await putBooking(bot.token, ref("KCD"), bookingBody({ doctorRef: "NO-SUCH-DOCTOR" }));
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error.code, "DOCTOR_NOT_MAPPED");
  });

  it("applies a cancellation and ignores one for a booking it never saw", async () => {
    const r = ref("KCD");
    const made = await putBooking(bot.token, r, bookingBody());
    const cancel = await putBooking(bot.token, r, bookingBody({ status: "CANCELLED", cancelReason: "Caller cancelled" }));
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.data.outcome, "cancelled");
    assert.equal(cancel.body.data.appointment.status, "CANCELLED");
    const again = await putBooking(bot.token, r, bookingBody({ status: "CANCELLED" }));
    assert.equal(again.body.data.outcome, "unchanged");
    const unseen = await putBooking(bot.token, ref("KCD"), bookingBody({ status: "CANCELLED" }));
    assert.equal(unseen.body.data.outcome, "ignored");
    assert.equal(unseen.body.data.appointment, null);

    assert.ok(made.body.data.appointment.id);
  });

  it("cancels by booking number alone, refuses an unknown number and leaves a cancelled one as it is", async () => {
    const r = ref("KCD");
    await putBooking(bot.token, r, bookingBody());
    const c = await t.api("post", `/integrations/voice/bookings/${r}/cancel`, bot.token).send({ reason: "Caller cancelled" });
    assert.equal(c.status, 200);
    assert.equal(c.body.data.outcome, "cancelled");
    assert.equal(c.body.data.appointment.status, "CANCELLED");
    const again = await t.api("post", `/integrations/voice/bookings/${r}/cancel`, bot.token).send({});
    assert.equal(again.body.data.outcome, "unchanged");
    const unseen = await t.api("post", `/integrations/voice/bookings/${ref("KCD")}/cancel`, bot.token).send({});
    assert.equal(unseen.status, 404);
    assert.equal((await t.api("post", `/integrations/voice/bookings/${r}/cancel`, rec.token).send({})).status, 403);
  });

  it("refuses two bookings for the same doctor and time instead of overlapping them", async () => {
    const at = nextSlot();
    const first = await putBooking(bot.token, ref("KCD"), bookingBody({ startAt: at }));
    assert.equal(first.status, 201);
    const clash = await putBooking(bot.token, ref("KCD"), bookingBody({ startAt: at }));
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
  });

  it("validates strictly: unknown fields, tenant injection, bad ids and times are rejected", async () => {
    const cases: [string, string, Record<string, unknown>][] = [
      ["tenant injection", ref("KCD"), bookingBody({ tenantId: b.tenantId })],
      ["unknown field", ref("KCD"), bookingBody({ status2: "x" })],
      ["bad status", ref("KCD"), bookingBody({ status: "DONE" })],
      ["no timezone", ref("KCD"), bookingBody({ startAt: "2030-01-01T10:00:00" })],
      ["zero duration", ref("KCD"), bookingBody({ durationMinutes: 0 })],
      ["bad reference", "a b", bookingBody()],
      ["past time", ref("KCD"), bookingBody({ startAt: new Date(Date.now() - 3_600_000).toISOString() })],
    ];
    for (const [name, r, body] of cases) {
      const res = await putBooking(bot.token, encodeURIComponent(r), body);
      assert.ok(res.status === 400 || res.status === 404, `${name}: ${res.status} ${JSON.stringify(res.body)}`);
    }
  });

  it("keeps tenants apart: another hospital's bot cannot use this doctor, and the same booking number can exist in both", async () => {
    const r = ref("KCD");
    const crossDoctor = await putBooking(botB.token, r, bookingBody());
    assert.equal(crossDoctor.status, 422);
    assert.equal(crossDoctor.body.error.code, "DOCTOR_NOT_MAPPED");
    const dB = await putDoctor(botB.token, doctorRef, doctorBody());
    assert.equal(dB.status, 201);
    const inB = await putBooking(botB.token, r, bookingBody());
    const inA = await putBooking(bot.token, r, bookingBody());
    assert.equal(inB.status, 201);
    assert.equal(inA.status, 201);
    assert.equal(await t.prisma.appointment.count({ where: { externalRef: r } }), 2);
  });

  it("only the voice bot's own role may use it, and that role can do little else", async () => {
    for (const token of [rec.token, a.admin.token]) {
      assert.equal((await putBooking(token, ref("KCD"), bookingBody())).status, 403);
      assert.equal((await putDoctor(token, ref("DOC"), doctorBody())).status, 403);
    }
    assert.equal((await t.api("get", "/audit-events", bot.token)).status, 403);
    assert.equal((await t.api("get", "/users", bot.token)).status, 403);
    assert.equal((await t.api("post", "/appointments/walk-in", bot.token).send({})).status, 403);
    const anon = await t.api("put", `/integrations/voice/bookings/${ref("KCD")}`).send(bookingBody());
    assert.equal(anon.status, 401);
  });
});
