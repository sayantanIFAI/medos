import { z } from "zod";
import type { LlmClient } from "./llm";
import { dayHints } from "./spoken";

/**
 * What the model (or, when it is unreachable, the word rules) understood. Everything here is "what was SAID". Nothing in it is a fact
 * about the hospital: doctors, tests, rates and free times are looked up from MedOS afterwards by code, never taken from this object.
 */
export const INTENTS = ["LAB_RATE", "LAB_BOOK", "DOCTOR_FIND", "DOCTOR_BOOK", "YES", "NO", "CANCEL", "GREETING", "OTHER"] as const;
export type Intent = (typeof INTENTS)[number];

const str = (max: number) => z.string().trim().min(1).max(max).nullable().catch(null);
const int = (min: number, max: number) => z.number().int().min(min).max(max).nullable().catch(null);

export const nluSchema = z.object({
  intent: z.enum(INTENTS).catch("OTHER"),
  language: z.enum(["hi", "en", "bn", "other"]).catch("other"),
  tests: z.array(z.string().trim().min(1).max(80)).max(12).catch([]),
  doctor: str(80),
  department: str(60),
  symptom: str(120),
  dayOffset: int(0, 60),
  isoDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
  weekday: int(0, 6),
  partOfDay: z.enum(["morning", "afternoon", "evening"]).nullable().catch(null),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().catch(null),
  patientName: str(80),
  age: int(0, 130),
  mobile: str(20),
  sex: z.enum(["MALE", "FEMALE"]).nullable().catch(null),
  homeCollection: z.boolean().nullable().catch(null),
});
export type Nlu = z.infer<typeof nluSchema>;

export const emptyNlu = (): Nlu => nluSchema.parse({});

const nullableString = { type: ["string", "null"] };
/**
 * What the model is asked to write, as JSON Schema, so it is constrained to it while it writes. Only what code cannot read reliably itself:
 * the intent and the names. Days, part of the day, clock times, ages and phone digits are read from the words by code (spoken.ts) and the
 * model's guesses for them were always discarded, so asking for them only made every answer slower (each field is generated, token by token,
 * on a GPU in another region). The rest of nluSchema keeps its defaults.
 */
export const NLU_JSON_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: [...INTENTS] },
    language: { type: "string", enum: ["hi", "en", "bn", "other"] },
    tests: { type: "array", items: { type: "string" } },
    doctor: nullableString, department: nullableString, symptom: nullableString, patientName: nullableString,
    sex: { type: ["string", "null"], enum: ["MALE", "FEMALE", null] },
    homeCollection: { type: ["boolean", "null"] },
  },
  required: ["intent", "language", "tests", "doctor", "department", "symptom", "patientName", "sex", "homeCollection"],
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function systemPrompt(todayIso: string, weekday: number): string {
  return [
    "You turn a caller's words into JSON for a hospital booking system. The caller speaks Hindi, English or a mix (Hinglish), possibly written in Devanagari.",
    "Return ONLY JSON that matches the schema. Rules:",
    "- Extract only what the caller actually said. Use null (or [] for tests) when something was not said. Never guess. Never answer the caller.",
    "- intent: LAB_RATE = asks the price or rate of a lab test. LAB_BOOK = wants to book a lab test or sample collection. DOCTOR_FIND = asks which doctors or times are available. DOCTOR_BOOK = wants an appointment with a doctor. YES = agrees or confirms. NO = declines. CANCEL = wants to stop. GREETING = only a greeting. OTHER = anything else.",
    "- tests: the lab test names exactly as spoken, keeping Devanagari as spoken, for example [\"थायराइड\", \"CBC\"].",
    "- doctor: the doctor's name written in English letters (transliterate if spoken in Hindi), without the word Doctor.",
    "- department: the specialty or body part as spoken, for example \"हड्डी\" or \"cardiology\". symptom: the complaint as spoken, short.",
    `- Today is ${todayIso} (${WEEKDAYS[weekday]}). Days, times, ages and phone numbers are read separately; do not write them.`,
    "- patientName: the patient's name as spoken. sex: MALE or FEMALE only if said.",
    "- If a line says what the assistant just asked for, a short reply such as \"35\" or \"हाँ\" answers that question.",
  ].join("\n");
}

export interface NluContext { todayIso: string; weekday: number; awaiting: string | null }

/** Asks the model; anything that is not valid JSON of the right shape is treated as "could not understand", never trusted. */
export async function understandWithModel(llm: LlmClient, text: string, c: NluContext): Promise<Nlu> {
  const user = (c.awaiting ? `[The assistant just asked the caller for: ${c.awaiting}]\n` : "") + `Caller said: ${text}`;
  const raw = await llm.completeJson(systemPrompt(c.todayIso, c.weekday), user, NLU_JSON_SCHEMA);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("language model did not return JSON"); }
  return nluSchema.parse(parsed);
}

// ───── word rules: the fallback when the model cannot be reached ─────

const HI_DIGITS: Record<string, string> = { "०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6", "७": "7", "८": "8", "९": "9" };
const latinDigits = (s: string) => s.replace(/[०-९]/g, (d) => HI_DIGITS[d] as string);

/** A whole word, in any script: JavaScript's word-boundary only understands ASCII letters. */
const W = (alternatives: string, anchored = false) => new RegExp(`${anchored ? "^\\s*" : "(?<![\\p{L}\\p{M}\\p{N}])"}(?:${alternatives})(?![\\p{L}\\p{M}\\p{N}])`, "iu");

const RX = {
  yes: W("हाँ|हां|हा|जी हाँ|जी हां|जी|ठीक है|ठीक|सही|बिल्कुल|कर दो|कर दीजिए|कीजिए|yes|yeah|yep|ok|okay|sure|confirm|correct", true),
  no: W("नहीं|नही|ना|मत|रहने दो|no|nope|don'?t", true),
  cancel: /(?:रद्द|कैंसिल|cancel|stop|रुको|छोड़ो)/iu,
  rate: /(?:कितना|कितने|कितनी|रेट|दाम|कीमत|शुल्क|चार्ज|खर्च|फीस|price|rate|cost|charge|how much)/iu,
  book: /(?:बुक|करवाना|कराना|करानी|करवानी|अपॉइंटमेंट|अप्वाइंटमेंट|book|appointment|schedule)/iu,
  doctor: /(?:डॉक्टर|डाक्टर|दिखाना|दिखवाना|doctor|dr\.?|consult|specialist|विशेषज्ञ)/iu,
  lab: /(?:जांच|जाँच|टेस्ट|test|sample|सैंपल|खून|blood|lab|पैथ)/iu,
  home: /(?:घर पर|होम कलेक्शन|home collection|at home)/iu,
};

/** Good enough to keep the demo working without the model: intent, day, part of day, digits. The model understands far more. */
export function understandWithRules(text: string, awaiting: string | null): Nlu {
  const t = latinDigits(text);
  const n = emptyNlu();
  n.language = /[ऀ-ॿ]/.test(text) ? "hi" : /[A-Za-z]/.test(text) ? "en" : "other"; // digits alone say nothing about the language
  if (RX.yes.test(t)) n.intent = "YES";
  else if (RX.no.test(t)) n.intent = "NO";
  else if (RX.cancel.test(t)) n.intent = "CANCEL";
  else if (RX.rate.test(t)) n.intent = "LAB_RATE";
  else if (RX.book.test(t) && RX.doctor.test(t)) n.intent = "DOCTOR_BOOK";
  else if (RX.book.test(t) && RX.lab.test(t)) n.intent = "LAB_BOOK";
  else if (RX.doctor.test(t)) n.intent = "DOCTOR_FIND";
  else if (RX.lab.test(t)) n.intent = "LAB_BOOK";
  else if (/^\s*(?:नमस्ते|नमस्कार|हेलो|हैलो|hello|hi)\b/i.test(t)) n.intent = "GREETING";
  const h = dayHints(t);
  n.dayOffset = h.dayOffset; n.weekday = h.weekday; n.partOfDay = h.partOfDay; n.time = h.time;
  if (RX.home.test(t)) n.homeCollection = true;
  const digits = t.replace(/[^\d]/g, "");
  if (awaiting === "mobile" && digits.length >= 10) n.mobile = digits.slice(-10);
  else if (awaiting === "age" && /^\s*\d{1,3}\s*(?:साल|वर्ष|years?|yrs?)?\s*$/i.test(t)) n.age = Number(digits);
  else if (awaiting === "name" && !/\d/.test(t) && t.trim().split(/\s+/).length <= 4) n.patientName = text.trim().replace(/^(?:मेरा नाम|नाम|my name is|name is)\s*/i, "").replace(/\s*(?:है|hai)$/i, "").trim() || null;
  return n;
}
