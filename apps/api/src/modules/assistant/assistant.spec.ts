import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeUserWithPermissions, startApp, type TestApp, type TestTenant } from "../../test/harness";
import { AssistantService } from "./assistant.service";
import type { LlmClient } from "@medos/frontdesk-core";
import { emptyNlu, type Nlu } from "@medos/frontdesk-core";

/** A stand-in for the language model: the test says what the "model" understood for the next sentence. */
class ScriptedModel implements LlmClient {
  next: Partial<Nlu> | "garbage" = {};
  async completeJson(): Promise<string> {
    if (this.next === "garbage") return "I think the caller wants a doctor";
    return JSON.stringify({ ...emptyNlu(), ...this.next });
  }
}

describe("assistant (Hindi and English)", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let assistant: AssistantService;
  const model = new ScriptedModel();

  const say = async (token: string, text: string, understood: Partial<Nlu> | "garbage", sessionId?: string, lang?: "hi" | "en") => {
    model.next = understood;
    const r = await t.api("post", "/assistant/turn", token).send({ text, ...(sessionId ? { sessionId } : {}), ...(lang ? { lang } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data as { sessionId: string; reply: string; lang: string; awaiting: string | null; engine: string; booked: { type: string; id: string; reference: string } | null; understood: Record<string, unknown> };
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("asst-a");
    b = await t.makeTenant("asst-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    assistant = t.app.get(AssistantService);
    assistant.useModel(model);

    for (const x of [
      { code: "THY", name: "Thyroid Profile (T3 T4 TSH)", price: 700, aliases: ["thyroid", "थायराइड"], reportHours: 24, prepHi: "खाली पेट आएँ।", prepEn: "Come fasting." },
      { code: "CBC", name: "Complete Blood Count (CBC)", price: 400, aliases: ["blood count", "खून की जांच"] },
      { code: "FBS", name: "Blood Sugar Fasting", price: 120, aliases: ["fbs", "sugar", "खाली पेट शुगर"], fastingRequired: true },
      { code: "PPBS", name: "Blood Sugar PP", price: 120, aliases: ["ppbs", "sugar", "खाने के बाद शुगर"] },
    ]) assert.ok([200, 201].includes((await t.api("put", "/lab/tests", a.admin.token).send(x)).status));

    const dept = await t.prisma.department.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, name: "Cardiology", code: "CARDIO" } });
    for (const name of ["Dr. Anita Sen", "Dr. Anil Sen"]) {
      const p = await t.prisma.practitioner.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, departmentId: dept.id, displayName: name } });
      const windows = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, start: "10:00", end: "12:00", slotMinutes: 15 }));
      assert.equal((await t.api("put", `/practitioners/${p.id}/schedule`, a.admin.token).send({ windows })).status, 200);
    }
  });
  after(async () => { await t.close(); });

  it("answers a Hindi rate question from the catalogue, not from the model", async () => {
    const r = await say(rec.token, "थायराइड की जांच कितने की है", { intent: "LAB_RATE", language: "hi", tests: ["थायराइड"] });
    assert.equal(r.engine, "model");
    assert.equal(r.lang, "hi");
    assert.ok(r.reply.includes("₹700"), r.reply);
    assert.ok(r.reply.includes("Thyroid Profile"), r.reply);
    assert.ok(r.reply.includes("रिपोर्ट"), r.reply);
    // the rate is whatever MedOS holds now
    await t.api("put", "/lab/tests", a.admin.token).send({ code: "THY", name: "Thyroid Profile (T3 T4 TSH)", price: 750, aliases: ["thyroid", "थायराइड"] });
    const again = await say(rec.token, "थायराइड का रेट", { intent: "LAB_RATE", language: "hi", tests: ["थायराइड"] });
    assert.ok(again.reply.includes("₹750") && !again.reply.includes("₹700"), again.reply);
  });

  it("answers in English, adds up several tests, and asks which sugar test when it is ambiguous", async () => {
    const r = await say(rec.token, "how much for CBC and thyroid", { intent: "LAB_RATE", language: "en", tests: ["CBC", "thyroid"] });
    assert.equal(r.lang, "en");
    assert.ok(r.reply.includes("Total ₹1150"), r.reply);
    const amb = await say(rec.token, "sugar test rate", { intent: "LAB_RATE", language: "en", tests: ["sugar"] });
    assert.equal(amb.awaiting, "test_choice");
    assert.ok(amb.reply.includes("Blood Sugar Fasting") && amb.reply.includes("Blood Sugar PP"), amb.reply);
    const pick = await say(rec.token, "the fasting one", { intent: "OTHER", language: "en" }, amb.sessionId);
    assert.ok(pick.reply.includes("₹120"), pick.reply);
  });

  it("still works with word rules when the model returns rubbish", async () => {
    const r = await say(rec.token, "CBC ka rate kitna hai", "garbage");
    assert.equal(r.engine, "rules");
    assert.ok(r.reply.includes("₹400"), r.reply);
    const unknown = await say(rec.token, "ABCXYZ ka rate", "garbage");
    assert.ok(unknown.reply.length > 0);
  });

  it("books a lab test by voice, step by step, only after a yes, and writes it into MedOS", async () => {
    const s1 = await say(rec.token, "कल सुबह थायराइड टेस्ट बुक करना है", { intent: "LAB_BOOK", language: "hi", tests: ["थायराइड"], dayOffset: 1, partOfDay: "morning" });
    assert.equal(s1.awaiting, "name");
    const s2 = await say(rec.token, "राजेश कुमार", { intent: "OTHER", patientName: "राजेश कुमार" }, s1.sessionId);
    assert.equal(s2.awaiting, "age");
    const s3 = await say(rec.token, "45", { intent: "OTHER", age: 45 }, s1.sessionId);
    assert.equal(s3.awaiting, "mobile");
    const s4 = await say(rec.token, "9830012345", { intent: "OTHER", mobile: "9830012345" }, s1.sessionId);
    assert.equal(s4.awaiting, "confirm");
    assert.ok(s4.reply.includes("राजेश कुमार") && s4.reply.includes("₹750") && s4.reply.includes("बुक करूँ"), s4.reply);
    assert.equal(await t.prisma.labBooking.count({ where: { tenantId: a.tenantId, source: "VOICE_ASSISTANT" } }), 0, "nothing booked before the yes");
    const done = await say(rec.token, "हाँ", { intent: "YES", language: "hi" }, s1.sessionId);
    assert.equal(done.booked?.type, "LAB");
    assert.ok(done.reply.includes("लैब बुकिंग हो गई") && done.reply.includes(done.booked?.reference ?? "?"), done.reply);
    const row = await t.prisma.labBooking.findFirstOrThrow({ where: { id: done.booked?.id }, include: { items: true, patient: true } });
    assert.equal(row.source, "VOICE_ASSISTANT");
    assert.equal(row.totalAmount.toFixed(2), "750.00");
    assert.equal(row.patient.estimatedAgeYears, 45);
    assert.equal(row.patient.mobile, "9830012345");
    assert.ok(row.collectionAt.getTime() > Date.now());
    // a second "yes" books nothing more
    const again = await say(rec.token, "हाँ", { intent: "YES" }, s1.sessionId);
    assert.equal(again.booked, null);
    assert.equal(await t.prisma.labBooking.count({ where: { tenantId: a.tenantId, source: "VOICE_ASSISTANT" } }), 1);
  });

  it("does not repeat the age question for ever: it says to type the answer", async () => {
    const s1 = await say(rec.token, "कल सुबह थायराइड टेस्ट बुक करना है", { intent: "LAB_BOOK", language: "hi", tests: ["थायराइड"], dayOffset: 1, partOfDay: "morning" });
    await say(rec.token, "मोहन लाल", { intent: "OTHER", patientName: "मोहन लाल" }, s1.sessionId);
    const first = await say(rec.token, "बस ठीक है", { intent: "OTHER" }, s1.sessionId);
    assert.equal(first.awaiting, "age");
    assert.ok(!first.reply.includes("टाइप"), "the first miss just asks again");
    const second = await say(rec.token, "देड़ा", { intent: "OTHER" }, s1.sessionId);
    assert.equal(second.awaiting, "age");
    assert.ok(second.reply.includes("टाइप"), second.reply);
    const typed = await say(rec.token, "13", { intent: "OTHER", age: 13 }, s1.sessionId);
    assert.equal(typed.awaiting, "mobile", "typing the age gets past it");
  });

  it("says a preparation instruction once when several tests share it", async () => {
    const prep = { prepHi: "बारह घंटे कुछ न खाएँ।", prepEn: "Do not eat for 12 hours." };
    for (const x of [{ code: "DUPA", name: "Zinc Level", price: 300, aliases: ["zinc"] }, { code: "DUPB", name: "Copper Level", price: 350, aliases: ["copper"] }]) {
      assert.ok([200, 201].includes((await t.api("put", "/lab/tests", a.admin.token).send({ ...x, ...prep })).status));
    }
    const s1 = await say(rec.token, "कल सुबह zinc और copper टेस्ट बुक करना है", { intent: "LAB_BOOK", language: "hi", tests: ["zinc", "copper"], dayOffset: 1, partOfDay: "morning" });
    await say(rec.token, "सीमा देवी", { intent: "OTHER", patientName: "सीमा देवी" }, s1.sessionId);
    await say(rec.token, "32", { intent: "OTHER", age: 32 }, s1.sessionId);
    await say(rec.token, "9830099999", { intent: "OTHER", mobile: "9830099999" }, s1.sessionId);
    const done = await say(rec.token, "हाँ", { intent: "YES", language: "hi" }, s1.sessionId);
    assert.equal(done.booked?.type, "LAB", done.reply);
    assert.equal(done.reply.split("बारह घंटे कुछ न खाएँ।").length - 1, 1, done.reply);
  });

  it("books a doctor by department: picks the earliest free doctor, asks for the patient, confirms, books", async () => {
    const s1 = await say(rec.token, "मुझे दिल के डॉक्टर को दिखाना है, परसों", { intent: "DOCTOR_BOOK", language: "hi", department: "दिल", dayOffset: 2 });
    assert.equal(s1.awaiting, "name", s1.reply);
    assert.equal(s1.understood.department, "Cardiology");
    await say(rec.token, "सुनीता देवी", { patientName: "सुनीता देवी" }, s1.sessionId);
    await say(rec.token, "38", { age: 38 }, s1.sessionId);
    const ask = await say(rec.token, "9830099999", { mobile: "9830099999" }, s1.sessionId);
    assert.equal(ask.awaiting, "confirm");
    assert.ok(ask.reply.includes("Cardiology") && ask.reply.includes("सुनीता देवी"), ask.reply);
    const done = await say(rec.token, "हाँ", { intent: "YES" }, s1.sessionId);
    assert.equal(done.booked?.type, "DOCTOR", done.reply);
    const appt = await t.prisma.appointment.findFirstOrThrow({ where: { id: done.booked?.id }, include: { patient: true, practitioner: true } });
    assert.equal(appt.source, "VOICE_ASSISTANT");
    assert.equal(appt.status, "BOOKED");
    assert.equal(appt.patient.firstName, "सुनीता");
    assert.ok(appt.practitioner.displayName.startsWith("Dr."));
    assert.equal(appt.endAt.getTime() - appt.startAt.getTime(), 15 * 60_000);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "APPOINTMENT_CREATED", entityId: appt.id } }));
  });

  it("books a named doctor at a named time, offers other times when it is taken, and never double-books", async () => {
    const ask = async (name: string, mobile: string, time: string | null, sessionId?: string) => {
      const s = await say(rec.token, "Dr Anita Sen at 10 AM tomorrow", { intent: "DOCTOR_BOOK", language: "en", doctor: "Anita Sen", dayOffset: 1, time }, sessionId);
      await say(rec.token, name, { patientName: name }, s.sessionId);
      await say(rec.token, "30", { age: 30 }, s.sessionId);
      const c = await say(rec.token, mobile, { mobile }, s.sessionId);
      return { s, c };
    };
    const first = await ask("Ravi Das", "9830011111", "10:00");
    assert.equal(first.c.awaiting, "confirm", first.c.reply);
    const done = await say(rec.token, "yes", { intent: "YES", language: "en" }, first.s.sessionId);
    assert.equal(done.booked?.type, "DOCTOR");
    const second = await say(rec.token, "Dr Anita Sen at 10 AM tomorrow", { intent: "DOCTOR_BOOK", language: "en", doctor: "Anita Sen", dayOffset: 1, time: "10:00" });
    assert.ok(second.reply.includes("not free"), second.reply);
    assert.equal(second.awaiting, "date");
    assert.equal(await t.prisma.appointment.count({ where: { tenantId: a.tenantId, source: "VOICE_ASSISTANT", patient: { firstName: "Ravi" } } }), 1);
  });

  it("asks which doctor when a name fits two, and does not book on an emergency", async () => {
    const r = await say(rec.token, "book Dr Sen", { intent: "DOCTOR_BOOK", language: "en", doctor: "Sen", dayOffset: 3 });
    assert.equal(r.awaiting, "doctor_choice");
    assert.ok(r.reply.includes("Dr. Anita Sen") && r.reply.includes("Dr. Anil Sen"), r.reply);
    const em = await say(rec.token, "सीने में तेज दर्द हो रहा है, डॉक्टर बुक करो", { intent: "DOCTOR_BOOK", language: "hi" });
    assert.ok(em.reply.includes("आपातकालीन"), em.reply);
    assert.equal(em.awaiting, null);
    const en = await say(rec.token, "he is unconscious", { intent: "OTHER" });
    assert.ok(en.reply.includes("emergency"), en.reply);
  });

  it("takes a 'no' at the read-back as 'change something', not as a booking", async () => {
    const s1 = await say(rec.token, "tomorrow morning CBC", { intent: "LAB_BOOK", language: "en", tests: ["CBC"], dayOffset: 1, partOfDay: "morning" });
    await say(rec.token, "Mina Roy", { patientName: "Mina Roy" }, s1.sessionId);
    await say(rec.token, "29", { age: 29 }, s1.sessionId);
    const c = await say(rec.token, "9830022222", { mobile: "9830022222" }, s1.sessionId);
    assert.equal(c.awaiting, "confirm");
    const no = await say(rec.token, "no", { intent: "NO" }, s1.sessionId);
    assert.ok(no.reply.includes("change"), no.reply);
    assert.equal(no.booked, null);
    assert.equal(await t.prisma.labBooking.count({ where: { tenantId: a.tenantId, patient: { firstName: "Mina" } } }), 0);
  });

  it("checks the user's own rights before booking, and a conversation belongs to who started it", async () => {
    const limited = await makeUserWithPermissions(t, a, ["ASSISTANT_USE", "LAB_READ"]);
    const rate = await say(limited.token, "CBC rate", { intent: "LAB_RATE", tests: ["CBC"], language: "en" });
    assert.ok(rate.reply.includes("₹400"));
    const book = await say(limited.token, "book CBC tomorrow", { intent: "LAB_BOOK", tests: ["CBC"], dayOffset: 1, language: "en" });
    assert.ok(book.reply.includes("permission"), book.reply);
    const noUse = await makeUserWithPermissions(t, a, ["LAB_READ"]);
    assert.equal((await t.api("post", "/assistant/turn", noUse.token).send({ text: "hello" })).status, 403);
    // someone else cannot continue my conversation: they get a fresh one
    const mine = await say(rec.token, "tomorrow morning CBC", { intent: "LAB_BOOK", tests: ["CBC"], dayOffset: 1, partOfDay: "morning", language: "en" });
    const other = await t.makeUser(a, ["RECEPTIONIST"]);
    const theirs = await say(other.token, "Mina Roy", { patientName: "Mina Roy" }, mine.sessionId);
    assert.notEqual(theirs.sessionId, mine.sessionId);
  });

  it("keeps hospitals apart: another hospital's assistant sees none of this hospital's tests or doctors", async () => {
    const recB = await t.makeUser(b, ["RECEPTIONIST"]);
    const r = await say(recB.token, "CBC rate", { intent: "LAB_RATE", tests: ["CBC"], language: "en" });
    assert.ok(!r.reply.includes("₹"), r.reply);
    const d = await say(recB.token, "book Dr Anita Sen", { intent: "DOCTOR_BOOK", doctor: "Anita Sen", language: "en" });
    assert.equal(d.booked, null);
    assert.ok(!d.reply.includes("Anita"), d.reply);
  });

  it("validates input strictly", async () => {
    for (const body of [{}, { text: "" }, { text: "x".repeat(601) }, { text: "hi", sessionId: "nope" }, { text: "hi", lang: "fr" }, { text: "hi", tenantId: b.tenantId }]) {
      const r = await t.api("post", "/assistant/turn", rec.token).send(body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await t.api("post", "/assistant/turn").send({ text: "hi" })).status, 401);
  });
});
