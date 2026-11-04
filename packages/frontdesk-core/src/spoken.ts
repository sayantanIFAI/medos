/**
 * The parts of speech that code reads more reliably than a language model: Hindi and English number words (ages, mobile numbers),
 * days ("कल", "सोमवार") and clock times ("शाम 5 बजे"). A 7-billion-parameter model turned "पैंतालीस साल" into 54 and invented times
 * nobody said, so these are read here, from the words, and the model's guesses for them are ignored.
 */

const DEVANAGARI_DIGITS = "०१२३४५६७८९";
const latin = (s: string) => s.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));

const ONES: Record<string, number> = {
  शून्य: 0, ज़ीरो: 0, जीरो: 0, zero: 0, एक: 1, one: 1, दो: 2, two: 2, तीन: 3, three: 3, चार: 4, four: 4, पाँच: 5, पांच: 5, five: 5, छह: 6, छः: 6, छ: 6, छे: 6, six: 6,
  सात: 7, seven: 7, आठ: 8, eight: 8, नौ: 9, nine: 9,
};

/** The Hindi words for 10..99, in order. */
const HI_TENS = "दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस चौवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उनासी अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे".split(" ");
const HI_NUMBERS: Record<string, number> = {};
HI_TENS.forEach((w, i) => { HI_NUMBERS[w] = 10 + i; });
// common alternative spellings a recogniser writes
Object.assign(HI_NUMBERS, { तेरा: 13, चौदा: 14, पंद्रा: 15, पन्द्रा: 15, सोला: 16, सत्रा: 17, अठारा: 18, पन्द्रह: 15, सताईस: 27, अठाईस: 28, सैंतालिस: 47, पैतालीस: 45, पैंतालिस: 45, चौबिस: 24, पच्चिस: 25 });
for (const [w, v] of Object.entries(ONES)) HI_NUMBERS[w] = v;
Object.assign(HI_NUMBERS, { सौ: 100, hundred: 100, ten: 10 });

const tokens = (s: string) => latin(s.normalize("NFKC")).toLowerCase().replace(/[,.;:!?।]/g, " ").split(/\s+/).filter(Boolean);

/** A whole number said as digits, Devanagari digits, Hindi words ("पैंतालीस") or English words ("forty five" is not handled; digits are). 0..130. */
export function spokenNumber(text: string): number | null {
  for (const tok of tokens(text)) {
    if (/^\d{1,3}$/.test(tok)) { const n = Number(tok); if (n <= 130) return n; }
    const w = HI_NUMBERS[tok];
    if (w !== undefined) return w;
  }
  return null;
}

/** Digits said one by one ("नौ आठ तीन शून्य ..." or "9 8 3 0 ..." or "9830012345"), with "double"/"डबल" and "triple" repeats. */
export function spokenDigits(text: string): string {
  let out = "";
  const toks = tokens(text);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i] as string;
    if (/^\d+$/.test(tok)) { out += tok; continue; }
    const rep = tok === "double" || tok === "डबल" ? 2 : tok === "triple" || tok === "ट्रिपल" ? 3 : 1;
    if (rep > 1) { const d = ONES[toks[i + 1] ?? ""]; if (d !== undefined) { out += String(d).repeat(rep); i++; } continue; }
    const d = ONES[tok];
    if (d !== undefined) out += String(d);
  }
  return out;
}

export interface DayHints { dayOffset: number | null; weekday: number | null; partOfDay: "morning" | "afternoon" | "evening" | null; time: string | null }

const WEEKDAY_WORDS: [number, string[]][] = [
  [0, ["रविवार", "इतवार", "sunday", "ravivar", "itwar"]], [1, ["सोमवार", "monday", "somvar", "somwar"]], [2, ["मंगलवार", "tuesday", "mangalvar", "mangalwar"]],
  [3, ["बुधवार", "wednesday", "budhvar", "budhwar"]], [4, ["गुरुवार", "बृहस्पतिवार", "वीरवार", "thursday", "guruvar", "guruwar", "brihaspativar", "veervar"]],
  [5, ["शुक्रवार", "friday", "shukravar", "shukrawar"]], [6, ["शनिवार", "saturday", "shanivar", "shaniwar"]],
];

/** A whole word, in any script: JavaScript's word-boundary only understands ASCII letters. */
const W = (alternatives: string) => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{M}\\p{N}])`, "u");

/** Day, part of the day and clock time, read from the words. Anything not said stays null. */
export function dayHints(text: string): DayHints {
  const t = latin(text.normalize("NFKC")).toLowerCase();
  const out: DayHints = { dayOffset: null, weekday: null, partOfDay: null, time: null };
  if (W("परसों|parson|parso|day after tomorrow").test(t)) out.dayOffset = 2;
  else if (W("कल|kal|tomorrow").test(t)) out.dayOffset = 1;
  else if (W("आज|aaj|aj|today").test(t)) out.dayOffset = 0;
  if (out.dayOffset === null) for (const [d, words] of WEEKDAY_WORDS) if (words.some((w) => W(w).test(t))) { out.weekday = d; break; }
  if (W("सुबह|subah|subha|morning").test(t)) out.partOfDay = "morning";
  else if (W("दोपहर|dopahar|dophar|afternoon|noon").test(t)) out.partOfDay = "afternoon";
  else if (W("शाम|sham|evening|रात|raat|night").test(t)) out.partOfDay = "evening";

  // a clock time: "5 बजे", "5:30 pm", "11 baje", "पाँच बजे", "08:30"
  const num = String.raw`(\d{1,2})(?::(\d{2}))?`;
  let hour: number | null = null; let minute = 0; let marker = "";
  const m1 = new RegExp(`${num}\\s*(am|pm|a\\.m\\.|p\\.m\\.|बजे|बजकर|baje|bje)`).exec(t);
  if (m1) { hour = Number(m1[1]); minute = m1[2] ? Number(m1[2]) : 0; marker = m1[3] as string; }
  else {
    const m2 = /(?:^|\s)(\S+)\s*(?:बजे|baje)/u.exec(t);
    const w = m2 ? HI_NUMBERS[m2[1] as string] : undefined;
    if (w !== undefined && w >= 1 && w <= 12) hour = w;
    else { const m3 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(t); if (m3) { hour = Number(m3[1]); minute = Number(m3[2]); marker = "24h"; } }
  }
  if (hour !== null && hour <= 23 && minute <= 59) {
    if (marker.startsWith("p") && hour < 12) hour += 12;
    else if (marker.startsWith("a") && hour === 12) hour = 0;
    else if (marker !== "24h" && !marker.startsWith("a") && !marker.startsWith("p")) {
      // "5 बजे": the part of the day decides; with none said, clinic hours make 1-6 an afternoon time and 7-11 a morning time
      if (out.partOfDay === "evening" || out.partOfDay === "afternoon") { if (hour < 12) hour += 12; if (hour === 24) hour = 12; }
      else if (out.partOfDay === "morning") { if (hour === 12) hour = 0; }
      else if (hour >= 1 && hour <= 6) hour += 12;
    }
    out.time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  return out;
}
