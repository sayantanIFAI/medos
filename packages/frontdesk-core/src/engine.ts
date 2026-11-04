import { DomainError, type Permission } from "@medos/shared";
import { randomUUID } from "node:crypto";
import { localDateStr, localMinutes, localParts, zonedToUtc } from "./time";
import { normalizeText } from "./lab-match";
import { matchDoctors } from "./doctors.match";
import { departmentFragments, departmentMatches, looksLikeEmergency } from "./departments";
import type { LlmClient } from "./llm";
import { understandWithModel, understandWithRules, type Nlu } from "./nlu";
import { T, dateWords, timeWords, type Lang, type LabLine } from "./replies";
import { dayHints, spokenDigits, spokenNumber } from "./spoken";
import type { DoctorPick, FrontDeskPort, LabPick } from "./port";

/**
 * The front-desk dialogue: a person speaks or types in Hindi or English; the assistant finds lab rates, finds a doctor's free time and
 * books. It runs inside the voicebot app (and inside MedOS for the built-in screen) and reaches MedOS only through a FrontDeskPort.
 *
 * The one rule: the model decides what was ASKED; code decides what is TRUE. The model only turns words into a structured request
 * (nlu.ts). Doctors, tests, rates, free times and booking numbers all come from MedOS records, and every sentence spoken back is a
 * template (replies.ts) filled from them. Booking needs an explicit "yes" to a read-back, and uses the connected user's own rights.
 */

type Awaiting = "tests" | "test_choice" | "date" | "collection_date" | "doctor" | "doctor_choice" | "name" | "age" | "mobile" | "confirm" | null;

interface Session {
  id: string; owner: string; touched: number; lang: Lang;
  flow: "lab" | "doctor" | null; awaiting: Awaiting; bookings: number;
  tests: LabPick[]; testOptions: { id: string; name: string }[];
  departmentFragment: string | null; doctorOptions: DoctorPick[]; doctor: DoctorPick | null;
  date: string | null; time: string | null; partOfDay: "morning" | "afternoon" | "evening" | null; slotStart: string | null;
  patient: { name: string | null; age: number | null; mobile: string | null; sex: "MALE" | "FEMALE" | null };
  homeCollection: boolean;
  /** Which detail was asked for last and how many times in a row (to stop an endless repeat). */
  asks?: { key: "name" | "age" | "mobile"; count: number } | undefined;
}

export interface TurnResult {
  sessionId: string; reply: string; lang: Lang; awaiting: Awaiting; engine: "model" | "rules";
  booked: { type: "DOCTOR" | "LAB"; id: string; reference: string } | null;
  /** What has been understood so far, so the screen can show it. Never includes anything the caller did not say. */
  understood: { tests: string[]; doctor: string | null; department: string | null; date: string | null; time: string | null; patient: string | null };
}

const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 300;
const PART_START: Record<"morning" | "afternoon" | "evening", [number, number]> = { morning: [6 * 60, 12 * 60], afternoon: [12 * 60, 16 * 60], evening: [16 * 60, 21 * 60] };
const PART_DEFAULT_MIN: Record<"morning" | "afternoon" | "evening", number> = { morning: 8 * 60, afternoon: 13 * 60, evening: 17 * 60 };
const SEARCH_DAYS = 14;

/** Words that are heard in place of a name but are not one. A name is never made of these alone, and never holds digits. */
const NOT_NAMES = new Set(["बच्चे", "बच्चा", "बच्ची", "बेटा", "बेटी", "मरीज़", "मरीज", "पेशेंट", "नाम", "मेरा", "मेरी", "का", "की", "है", "हाँ", "हां", "नहीं", "जी", "ठीक", "child", "baby", "boy", "girl", "patient", "name", "my", "is", "yes", "no", "ok", "okay", "sir", "madam"]);
export function looksLikeAName(name: string): boolean {
  const words = name.toLowerCase().replace(/[.,;:!?।]/g, " ").split(/\s+/).filter(Boolean);
  return words.length > 0 && !/\d/.test(name) && name.trim().length >= 2 && !words.every((w) => NOT_NAMES.has(w));
}

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const shortRef = (id: string) => id.slice(0, 8).toUpperCase();

export interface EngineLog { warn(message: string): void; error(message: string): void }

export class FrontDeskEngine {
  private readonly sessions = new Map<string, Session>();

  constructor(private llm: LlmClient | null, private readonly log: EngineLog = { warn: () => undefined, error: () => undefined }) {}

  /** Whether a language model is connected (the screen shows it; the assistant works from word rules without one). */
  get modelConfigured(): boolean { return this.llm !== null; }

  /** For tests: swap in a fake model. */
  useModel(llm: LlmClient | null): void { this.llm = llm; }

  // ───── session ─────

  private session(owner: string, id: string | undefined, langHint: Lang | undefined): Session {
    const now = Date.now();
    for (const [k, s] of this.sessions) if (now - s.touched > SESSION_TTL_MS) this.sessions.delete(k);
    if (this.sessions.size >= MAX_SESSIONS) { const oldest = [...this.sessions.values()].sort((a, b) => a.touched - b.touched)[0]; if (oldest) this.sessions.delete(oldest.id); }
    const found = id ? this.sessions.get(id) : undefined;
    // a conversation belongs to the person (and hospital) who started it: the caller passes one key for both
    if (found && found.owner === owner) { found.touched = now; return found; }
    const s: Session = {
      id: randomUUID(), owner, touched: now, lang: langHint ?? "hi", flow: null, awaiting: null, bookings: 0,
      tests: [], testOptions: [], departmentFragment: null, doctorOptions: [], doctor: null, date: null, time: null, partOfDay: null, slotStart: null,
      patient: { name: null, age: null, mobile: null, sex: null }, homeCollection: false,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  private reset(s: Session): void {
    s.asks = undefined; s.flow = null; s.awaiting = null; s.tests = []; s.testOptions = []; s.departmentFragment = null; s.doctorOptions = []; s.doctor = null;
    s.date = null; s.time = null; s.partOfDay = null; s.slotStart = null; s.homeCollection = false;
  }

  // ───── the turn ─────

  async turn(owner: string, port: FrontDeskPort, input: { sessionId?: string; text: string; lang?: Lang }): Promise<TurnResult> {
    const s = this.session(owner, input.sessionId, input.lang);
    const tz = await port.timezone();
    const today = localDateStr(new Date(), tz);
    if (input.lang) s.lang = input.lang;

    const done = (reply: string, booked: TurnResult["booked"] = null, engine: TurnResult["engine"] = "rules"): TurnResult => ({
      sessionId: s.id, reply, lang: s.lang, awaiting: s.awaiting, engine, booked,
      understood: {
        tests: s.tests.map((t) => t.name), doctor: s.doctor?.name ?? null, department: s.doctor?.departmentName ?? null,
        date: s.date, time: s.time ?? (s.slotStart ? hm(localMinutes(new Date(s.slotStart), tz)) : null), patient: s.patient.name,
      },
    });

    try {
      if (looksLikeEmergency(input.text)) { this.reset(s); return done(T.emergency(this.langOf(s, input.text))); }

      const { nlu, engine } = await this.understand(input.text, s, today, tz);
      if (nlu.language === "hi" || nlu.language === "en") s.lang = nlu.language;
      else if (/[ऀ-ॿ]/.test(input.text)) s.lang = "hi";
      this.merge(s, nlu, today, tz);

      const out = await this.step(port, s, nlu, input.text, today, tz);
      return done(out.reply, out.booked ?? null, engine);
    } catch (e) {
      if (e instanceof DomainError && e.httpStatus < 500) {
        if (e.code === "FORBIDDEN") return done(T.noPermission(s.lang));
        this.log.warn(`turn refused: ${e.code}`);
        return done(T.problem(s.lang));
      }
      this.log.error(`turn failed: ${e instanceof Error ? e.message : String(e)}`);
      return done(T.problem(s.lang));
    }
  }

  /** Devanagari means Hindi, plain Latin letters mean English, anything else keeps what the conversation was using. */
  private langOf(s: Session, text: string): Lang { return /[ऀ-ॿ]/.test(text) ? "hi" : /[A-Za-z]/.test(text) ? "en" : s.lang; }

  /**
   * Open requests go to the model. Short answers to a question the assistant just asked (name, age, mobile, yes/no) are read by code:
   * faster, and exact. Whatever the model says about days, times, ages and phone digits is replaced by what the words themselves say.
   */
  private async understand(text: string, s: Session, today: string, tz: string): Promise<{ nlu: Nlu; engine: "model" | "rules" }> {
    const slotFill = s.awaiting === "name" || s.awaiting === "age" || s.awaiting === "mobile" || s.awaiting === "confirm";
    let nlu: Nlu | null = null;
    let engine: "model" | "rules" = "rules";
    if (!slotFill && this.llm) {
      const weekday = localParts(zonedToUtc(today, 12 * 60, tz), tz).weekday;
      try { nlu = await understandWithModel(this.llm, text, { todayIso: today, weekday, awaiting: s.awaiting }); engine = "model"; }
      catch (e) { this.log.warn(`language model unavailable, using word rules (${e instanceof Error ? e.message : String(e)})`); }
    }
    return { nlu: this.applyReadings(nlu ?? understandWithRules(text, s.awaiting), text, s.awaiting), engine };
  }

  private applyReadings(n: Nlu, text: string, awaiting: Awaiting): Nlu {
    const h = dayHints(text);
    n.dayOffset = h.dayOffset; n.weekday = h.weekday; n.partOfDay = h.partOfDay; n.time = h.time; n.isoDate = null;
    const ageCue = awaiting === "age" || /(?:साल|वर्ष|उम्र|years?|yrs?|age)/i.test(text);
    n.age = ageCue ? spokenNumber(text) : null;
    const digits = spokenDigits(text);
    n.mobile = awaiting === "mobile" ? (digits.length >= 10 ? digits.slice(-10) : digits || null) : digits.length >= 10 ? digits.slice(-10) : null;
    if (awaiting === "name" && !n.patientName) n.patientName = text.replace(/^\s*(?:मेरा नाम|मरीज़ का नाम|नाम|my name is|name is|patient is)\s*/i, "").replace(/\s*(?:है|hai|हूँ)\s*$/i, "").trim().slice(0, 80) || null;
    if (awaiting === "name" || awaiting === "age" || awaiting === "mobile") {
      // the caller is answering a question: nothing else in the sentence starts a new request
      if (n.intent !== "CANCEL") n.intent = "OTHER";
      n.tests = []; n.doctor = null; n.department = null; n.symptom = null;
      if (awaiting !== "name") n.patientName = null;
    }
    return n;
  }

  // ───── remember what was said ─────

  private merge(s: Session, n: Nlu, today: string, tz: string): void {
    const date = this.dateOf(n, today, tz);
    if (date) s.date = date;
    if (n.time) { s.time = n.time; s.partOfDay = null; }
    else if (n.partOfDay) { s.partOfDay = n.partOfDay; if (date || !s.time) s.time = null; }
    // a word like "child" or "yes" is not a name: ask again instead of registering a patient called that
    if (n.patientName && looksLikeAName(n.patientName)) s.patient.name = n.patientName;
    if (n.age !== null) s.patient.age = n.age;
    if (n.mobile) s.patient.mobile = n.mobile.replace(/[^\d]/g, "").slice(-10) || null;
    if (n.sex) s.patient.sex = n.sex;
    if (n.homeCollection !== null) s.homeCollection = n.homeCollection;
  }

  private dateOf(n: Nlu, today: string, tz: string): string | null {
    if (n.isoDate && n.isoDate >= today) return n.isoDate;
    if (n.dayOffset !== null) return localDateStr(new Date(zonedToUtc(today, 12 * 60, tz).getTime() + n.dayOffset * 86_400_000), tz);
    if (n.weekday !== null) {
      const cur = localParts(zonedToUtc(today, 12 * 60, tz), tz).weekday;
      const ahead = (n.weekday - cur + 7) % 7 || 7; // "Monday" said on a Monday means next Monday
      return localDateStr(new Date(zonedToUtc(today, 12 * 60, tz).getTime() + ahead * 86_400_000), tz);
    }
    return null;
  }

  // ───── what to do next ─────

  private need(port: FrontDeskPort, ...perms: Permission[]): void {
    for (const p of perms) if (!port.can(p)) throw new DomainError("FORBIDDEN", "You do not have permission for this", 403);
  }

  private async step(port: FrontDeskPort, s: Session, n: Nlu, text: string, today: string, tz: string): Promise<{ reply: string; booked?: TurnResult["booked"] }> {
    const lang = s.lang;

    if (n.intent === "CANCEL") { this.reset(s); return { reply: T.cancelled(lang) }; }
    if (n.intent === "GREETING" && !s.flow) return { reply: T.greet(lang) };

    if (n.intent === "YES") {
      if (s.awaiting === "confirm") return this.book(port, s, today, tz);
      if (!s.flow) return { reply: T.nothingToConfirm(lang) };
    }
    if (n.intent === "NO") {
      if (s.awaiting === "confirm") { s.awaiting = null; s.slotStart = null; return { reply: T.needChange(lang) }; }
      if (s.awaiting === "date" && s.flow) { s.date = null; s.time = null; s.partOfDay = null; s.slotStart = null; return { reply: T.askDate(lang) }; }
      if (s.flow) { this.reset(s); return { reply: T.cancelled(lang) }; }
    }

    // answering a question the assistant just asked
    if (s.awaiting === "test_choice") {
      await this.chooseTest(port, s, text);
      if (!s.testOptions.length && s.tests.length && !s.flow) { s.awaiting = null; this.need(port, "LAB_READ"); return { reply: this.ratesReply(s) }; }
    }
    if (s.awaiting === "doctor_choice") this.chooseDoctor(s, text);

    if (n.intent === "LAB_RATE") {
      this.need(port, "LAB_READ");
      await this.collectTests(port, s, n, text);
      if (s.testOptions.length) { s.awaiting = "test_choice"; return { reply: T.askTestChoice(s.testOptions.map((o) => o.name), lang) }; }
      if (!s.tests.length) { s.awaiting = "tests"; return { reply: n.tests.length ? T.testsNotFound(lang) : T.askTests(lang) }; }
      s.awaiting = null;
      return { reply: this.ratesReply(s) };
    }

    if (n.intent === "LAB_BOOK") { s.flow = "lab"; }
    if (n.intent === "DOCTOR_BOOK" || n.intent === "DOCTOR_FIND") { s.flow = "doctor"; }

    if (s.flow === "lab") {
      this.need(port, "LAB_BOOK");
      return this.labFlow(port, s, n, text, today, tz);
    }
    if (s.flow === "doctor") {
      this.need(port, "APPOINTMENT_READ");
      return this.doctorFlow(port, s, n, text, today, tz, n.intent !== "DOCTOR_FIND");
    }

    // a bare answer with no flow, e.g. the caller just names a test
    if (n.tests.length) {
      this.need(port, "LAB_READ");
      await this.collectTests(port, s, n, text);
      if (s.tests.length) return { reply: this.ratesReply(s) };
    }
    return { reply: T.didNotUnderstand(lang) };
  }

  // ───── lab tests ─────

  private async collectTests(port: FrontDeskPort, s: Session, n: Nlu, text: string): Promise<void> {
    const found = await port.findTests([...n.tests, text].join(" , "));
    const high = found.filter((m) => m.confidence === "HIGH");
    const med = found.filter((m) => m.confidence === "MEDIUM" && m.reason === "ambiguous" && !high.some((h) => h.testId === m.testId));
    if (high.length) {
      const have = new Set(s.tests.map((t) => t.id));
      const details = await port.labTests(high.map((h) => h.testId).filter((id) => !have.has(id)));
      for (const d of details) s.tests.push(d);
    }
    s.testOptions = high.length ? [] : med.map((m) => ({ id: m.testId, name: m.name }));
  }

  private async chooseTest(port: FrontDeskPort, s: Session, text: string): Promise<void> {
    const t = normalizeText(text);
    const pick = s.testOptions.find((o) => normalizeText(o.name).split(" ").some((w) => w.length > 2 && t.includes(w)) && s.testOptions.filter((x) => normalizeText(x.name).split(" ").some((w) => w.length > 2 && t.includes(w))).length === 1)
      ?? (/(?:पहला|पहली|first|1\b)/i.test(text) ? s.testOptions[0] : /(?:दूसरा|दूसरी|second|2\b)/i.test(text) ? s.testOptions[1] : undefined)
      ?? (/(?:खाली|fasting|फास्टिंग)/i.test(text) ? s.testOptions.find((o) => /fasting/i.test(o.name)) : /(?:बाद|\bpp\b|post|ppbs)/i.test(text) ? s.testOptions.find((o) => /\bpp\b|post/i.test(o.name)) : undefined);
    if (!pick) return;
    const d = (await port.labTests([pick.id]))[0];
    if (d && !s.tests.some((x) => x.id === d.id)) s.tests.push(d);
    s.testOptions = [];
  }

  private lines(s: Session): { lines: LabLine[]; total: string } {
    let total = 0;
    const lines = s.tests.map((t) => {
      total += Math.round(Number(t.price) * 100);
      return { name: t.name, price: t.price, reportHours: t.reportHours, fastingRequired: t.fastingRequired, prep: s.lang === "hi" ? t.prepHi : t.prepEn };
    });
    return { lines, total: (total / 100).toFixed(2) };
  }

  private ratesReply(s: Session): string { const { lines, total } = this.lines(s); return T.labRates(lines, total, s.lang); }

  private collectionAt(s: Session, tz: string): Date | null {
    if (!s.date) return null;
    const fasting = s.tests.some((t) => t.fastingRequired);
    const minutes = s.time ? Number(s.time.slice(0, 2)) * 60 + Number(s.time.slice(3, 5)) : PART_DEFAULT_MIN[s.partOfDay ?? (fasting ? "morning" : "morning")];
    return zonedToUtc(s.date, minutes, tz);
  }

  private async labFlow(port: FrontDeskPort, s: Session, n: Nlu, text: string, today: string, tz: string): Promise<{ reply: string }> {
    const lang = s.lang;
    await this.collectTests(port, s, n, text);
    if (s.testOptions.length) { s.awaiting = "test_choice"; return { reply: T.askTestChoice(s.testOptions.map((o) => o.name), lang) }; }
    if (!s.tests.length) { s.awaiting = "tests"; return { reply: n.tests.length ? T.testsNotFound(lang) : T.askTests(lang) }; }
    if (!s.date) { s.awaiting = "collection_date"; return { reply: `${this.ratesReply(s).replace(/(?:बुक करवाना चाहें तो बताइए।|Tell me if you want to book\.)$/, "").trim()} ${T.askCollectionDate(lang)}` }; }
    const at = this.collectionAt(s, tz);
    if (!at || at.getTime() < Date.now() - 5 * 60_000) { s.date = null; s.awaiting = "collection_date"; return { reply: T.askCollectionDate(lang) }; }
    const ask = this.askPatient(s, today);
    if (ask) return { reply: ask };
    s.awaiting = "confirm";
    const { total } = this.lines(s);
    return { reply: T.confirmLab({ name: s.patient.name as string, age: s.patient.age as number, mobile: s.patient.mobile, tests: s.tests.map((t) => t.name), total, when: `${dateWords(s.date as string, today, lang)}, ${timeWords(hm(localMinutes(at, tz)), lang)}`, home: s.homeCollection }, lang) };
  }

  /** Name, then age, then a mobile number, one question at a time. Returns the question, or null when all three are known. */
  private askPatient(s: Session, _today: string): string | null {
    const lang = s.lang;
    // the second time the same thing is asked, say how to get past it (typing) instead of repeating the question for ever
    const ask = (key: "name" | "age" | "mobile", question: string): string => {
      s.awaiting = key;
      s.asks = s.asks?.key === key ? { key, count: s.asks.count + 1 } : { key, count: 1 };
      // asked, not understood once (try speaking again), not understood twice (suggest typing)
      return s.asks.count >= 3 ?`${question} ${T.typeTip(lang)}` : question;
    };
    if (!s.patient.name) return ask("name", T.askName(lang));
    if (s.patient.age === null) return ask("age", T.askAge(s.patient.name, lang));
    if (!s.patient.mobile || s.patient.mobile.length !== 10 || !/^[6-9]/.test(s.patient.mobile)) {
      const had = s.patient.mobile !== null;
      s.patient.mobile = null;
      return ask("mobile", had ? T.badMobile(lang) : T.askMobile(lang));
    }
    s.asks = undefined;
    return null;
  }

  // ───── doctors ─────

  private async doctorsFor(port: FrontDeskPort, s: Session, n: Nlu, text: string): Promise<void> {
    const all: DoctorPick[] = await port.doctors();
    s.doctorOptions = [];
    if (n.doctor) {
      const matched = matchDoctors(n.doctor, all);
      if (matched.length === 1) { s.doctor = matched[0] as DoctorPick; s.departmentFragment = null; return; }
      if (matched.length > 1) { s.doctorOptions = matched.slice(0, 4); s.doctor = null; return; }
    }
    const frags = departmentFragments([n.department, n.symptom, text].filter(Boolean).join(" , "));
    if (frags.length && !s.doctor) s.departmentFragment = frags[0] as string;
  }

  private chooseDoctor(s: Session, text: string): void {
    const t = normalizeText(text);
    const hit = s.doctorOptions.filter((d) => normalizeText(d.name).split(" ").some((w) => w.length > 2 && t.includes(w)));
    const idx = /(?:पहला|पहले|first|1\b)/i.test(text) ? 0 : /(?:दूसरा|दूसरे|second|2\b)/i.test(text) ? 1 : -1;
    const pick = hit.length === 1 ? hit[0] : idx >= 0 ? s.doctorOptions[idx] : undefined;
    if (pick) { s.doctor = pick; s.doctorOptions = []; }
  }

  /** Free slots for a doctor on a date, as minutes after local midnight with the instant, filtered by what the caller asked for. */
  private async freeSlots(port: FrontDeskPort, doctorId: string, date: string, tz: string, time: string | null, part: "morning" | "afternoon" | "evening" | null) {
    const slots = (await port.availability(doctorId, date)).filter((x) => x.available).map((x) => ({ startAt: x.startAt, minutes: localMinutes(new Date(x.startAt), tz) }));
    if (time) { const want = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)); return { exact: slots.filter((x) => x.minutes === want), all: slots }; }
    if (part) { const [a, b] = PART_START[part]; const inPart = slots.filter((x) => x.minutes >= a && x.minutes < b); return { exact: inPart, all: slots }; }
    return { exact: slots, all: slots };
  }

  private async earliestDate(port: FrontDeskPort, doctorId: string, from: string, tz: string): Promise<string | null> {
    for (let i = 0; i < SEARCH_DAYS; i++) {
      const d = localDateStr(new Date(zonedToUtc(from, 12 * 60, tz).getTime() + i * 86_400_000), tz);
      if ((await port.availability(doctorId, d)).some((x) => x.available)) return d;
    }
    return null;
  }

  private async doctorFlow(port: FrontDeskPort, s: Session, n: Nlu, text: string, today: string, tz: string, wantsBooking: boolean): Promise<{ reply: string }> {
    const lang = s.lang;
    await this.doctorsFor(port, s, n, text);
    if (!s.doctor && s.doctorOptions.length) { s.awaiting = "doctor_choice"; return { reply: T.askDoctorChoice(s.doctorOptions.map((d) => d.name), lang) }; }

    // a department: take the doctor with the earliest free time there
    if (!s.doctor && s.departmentFragment) {
      const rows = await port.doctors();
      const inDept = rows.filter((r) => r.departmentName && departmentMatches(r.departmentName, s.departmentFragment as string));
      if (!inDept.length) { s.departmentFragment = null; s.awaiting = "doctor"; return { reply: T.noDoctor(lang) }; }
      const from = s.date ?? today;
      let best: { d: DoctorPick; date: string } | null = null;
      for (const r of inDept.slice(0, 12)) {
        const date = s.date ? ((await port.availability(r.id, from)).some((x) => x.available) ? from : null) : await this.earliestDate(port, r.id, from, tz);
        if (date && (!best || date < best.date)) best = { d: r, date };
      }
      if (!best) { s.awaiting = "doctor"; return { reply: T.noSlots(inDept[0]?.departmentName ?? "", lang) }; }
      s.doctor = best.d;
    }
    if (!s.doctor) { s.awaiting = "doctor"; return { reply: n.doctor || n.department || n.symptom ? T.noDoctor(lang) : T.askDoctor(lang) }; }

    const doc = s.doctor;
    const dept = doc.departmentName ?? "";
    if (!s.date) {
      const first = await this.earliestDate(port, doc.id, today, tz);
      if (!first) { s.awaiting = "doctor"; s.doctor = null; return { reply: T.noSlots(doc.name, lang) }; }
      s.date = first;
      const { all } = await this.freeSlots(port, doc.id, first, tz, null, null);
      const firstSlot = all[0] as { minutes: number };
      s.awaiting = "date";
      return { reply: T.offer(doc.name, dept, `${dateWords(first, today, lang)}, ${timeWords(hm(firstSlot.minutes), lang)}`, lang) + (wantsBooking ? ` ${T.askDate(lang)}` : "") };
    }

    const { exact, all } = await this.freeSlots(port, doc.id, s.date, tz, s.time, s.partOfDay);
    if (!all.length) {
      const next = await this.earliestDate(port, doc.id, localDateStr(new Date(zonedToUtc(s.date, 12 * 60, tz).getTime() + 86_400_000), tz), tz);
      const failedDate = s.date;
      s.date = next;
      s.awaiting = "date";
      return { reply: T.noSlotThatDay(doc.name, dateWords(failedDate, today, lang), next ? dateWords(next, today, lang) : null, lang) };
    }
    if (!exact.length) {
      s.awaiting = "date"; s.time = null; s.partOfDay = null;
      return { reply: T.slotTaken(doc.name, dateWords(s.date, today, lang), all.slice(0, 3).map((x) => timeWords(hm(x.minutes), lang)), lang) };
    }
    const slot = exact[0] as { startAt: string; minutes: number };
    s.slotStart = slot.startAt;
    if (!wantsBooking) {
      s.awaiting = "date";
      return { reply: T.offer(doc.name, dept, `${dateWords(s.date, today, lang)}, ${timeWords(hm(slot.minutes), lang)}`, lang) };
    }
    const ask = this.askPatient(s, today);
    if (ask) return { reply: ask };
    s.awaiting = "confirm";
    return { reply: T.confirmDoctor({ name: s.patient.name as string, age: s.patient.age as number, mobile: s.patient.mobile, doctor: doc.name, dept, when: `${dateWords(s.date, today, lang)}, ${timeWords(hm(slot.minutes), lang)}` }, lang) };
  }

  // ───── book (only after an explicit yes to the read-back) ─────

  private async book(port: FrontDeskPort, s: Session, today: string, tz: string): Promise<{ reply: string; booked: TurnResult["booked"] }> {
    const lang = s.lang;
    const p = s.patient;
    s.bookings += 1;
    const ref = `ASSIST-${s.id.slice(0, 8)}-${s.bookings}`;
    this.need(port, "PATIENT_READ", "PATIENT_CREATE");
    const { patientId, mrn } = await port.resolvePatient(ref, { name: p.name as string, mobile: p.mobile ?? undefined, ageYears: p.age ?? undefined, sex: p.sex ?? "UNKNOWN" });

    if (s.flow === "lab") {
      this.need(port, "LAB_BOOK");
      const at = this.collectionAt(s, tz) as Date;
      const booking = await port.bookLab({ patientId, testIds: s.tests.map((t) => t.id), collectionAt: at.toISOString(), homeCollection: s.homeCollection, idempotencyKey: ref, source: "VOICE_ASSISTANT" });
      // the same instruction on several tests is said once
      const prep = [...new Set(s.tests.map((t) => (lang === "hi" ? t.prepHi : t.prepEn)).filter((x): x is string => !!x))].slice(0, 2);
      const when = `${dateWords(localDateStr(at, tz), today, lang)}, ${timeWords(hm(localMinutes(at, tz)), lang)}`;
      const reply = T.bookedLab({ ref: shortRef(booking.id), mrn, total: booking.totalAmount, when, prep }, lang);
      this.reset(s);
      return { reply, booked: { type: "LAB", id: booking.id, reference: shortRef(booking.id) } };
    }

    this.need(port, "APPOINTMENT_CREATE");
    const doc = s.doctor as DoctorPick;
    const start = new Date(s.slotStart as string);
    const dur = await this.slotMinutes(port, doc.id, s.date as string, start);
    const appt = await port.bookAppointment({ patientId, doctorId: doc.id, startAt: start.toISOString(), durationMinutes: dur, externalRef: ref, source: "VOICE_ASSISTANT" });
    const when = `${dateWords(s.date as string, today, lang)}, ${timeWords(hm(localMinutes(start, tz)), lang)}`;
    const reply = T.bookedDoctor({ ref: shortRef(appt.id), mrn, doctor: doc.name, dept: doc.departmentName ?? "", when }, lang);
    this.reset(s);
    return { reply, booked: { type: "DOCTOR", id: appt.id, reference: shortRef(appt.id) } };
  }

  private async slotMinutes(port: FrontDeskPort, doctorId: string, date: string, start: Date): Promise<number> {
    const slot = (await port.availability(doctorId, date)).find((x) => x.startAt === start.toISOString());
    return slot ? Math.round((Date.parse(slot.endAt) - Date.parse(slot.startAt)) / 60_000) : 15;
  }

  /** For tests only. */
  _sessionCount(): number { return this.sessions.size; }
  _peek(id: string): Session | undefined { return this.sessions.get(id); }
}
