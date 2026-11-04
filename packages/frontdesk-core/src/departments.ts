/**
 * Which department a spoken word points to. This is a DEMO table of everyday words for the voice bot's departments; the voice bot's own
 * version is clinician-approved, and this one must be reviewed by a clinician before real use. It only routes a caller to a department
 * to book with; it never says what is wrong. A word that fits no department, or fits several, books General Medicine only if the caller
 * agrees; the assistant never guesses silently.
 */
export interface DeptRule { fragment: string; words: string[] }

export const DEPT_RULES: DeptRule[] = [
  { fragment: "cardio", words: ["दिल", "हृदय", "सीने", "छाती", "हार्ट", "heart", "cardio", "cardiologist", "chest"] },
  { fragment: "orthop", words: ["हड्डी", "जोड़", "घुटना", "घुटने", "कमर", "फ्रैक्चर", "bone", "joint", "ortho", "orthopaedic", "orthopedic", "knee", "back pain", "fracture"] },
  { fragment: "gynae", words: ["महिला रोग", "प्रसूति", "गर्भ", "प्रेग्नेंसी", "माहवारी", "पीरियड", "gynae", "gynaecologist", "gynecologist", "pregnancy", "obstetric", "ladies doctor"] },
  { fragment: "paediat", words: ["बच्चा", "बच्चे", "बच्चों", "बाल रोग", "child", "baby", "paediatric", "pediatric", "paediatrician", "pediatrician"] },
  { fragment: "ent", words: ["कान", "नाक", "गला", "ear", "nose", "throat", "ent"] },
  { fragment: "dermat", words: ["त्वचा", "चमड़ी", "चर्म", "skin", "rash", "dermatologist", "dermatology"] },
  { fragment: "diabet", words: ["शुगर", "मधुमेह", "डायबिटीज", "थायराइड", "diabetes", "diabetic", "sugar doctor", "thyroid", "endocrin"] },
  { fragment: "dent", words: ["दांत", "दाँत", "डेंटल", "dental", "dentist", "tooth", "teeth"] },
  { fragment: "general surgery", words: ["सर्जरी", "ऑपरेशन", "surgery", "surgeon", "hernia", "appendix"] },
  { fragment: "neurolog", words: ["दिमाग", "सिरदर्द", "सिर दर्द", "मिर्गी", "लकवा", "brain", "headache", "migraine", "seizure", "neurologist"] },
  { fragment: "urolog", words: ["पेशाब", "गुर्दा", "किडनी", "पथरी", "kidney", "urine", "stone", "urologist"] },
  { fragment: "gastro", words: ["पेट", "लीवर", "लिवर", "पाचन", "एसिडिटी", "stomach", "liver", "acidity", "gastro", "gastroenterologist"] },
  { fragment: "psychiatr", words: ["मानसिक", "तनाव", "डिप्रेशन", "चिंता", "mental", "stress", "depression", "anxiety", "psychiatrist"] },
  { fragment: "general medicine", words: ["बुखार", "सर्दी", "खांसी", "जुकाम", "कमजोरी", "फिजिशियन", "fever", "cold", "cough", "physician", "general doctor", "general medicine"] },
];

import { normalizeText } from "./lab-match";

/** The department fragments a phrase points to, best (longest) word first. Whole words only for Latin text. */
export function departmentFragments(phrase: string): string[] {
  const text = ` ${normalizeText(phrase)} `;
  const hits: { fragment: string; len: number }[] = [];
  for (const rule of DEPT_RULES) {
    for (const w of rule.words) {
      const nw = normalizeText(w);
      if (!nw) continue;
      const latin = /^[a-z0-9 ]+$/.test(nw);
      if (latin ? text.includes(` ${nw} `) : text.includes(nw)) { hits.push({ fragment: rule.fragment, len: nw.length }); break; }
    }
  }
  return hits.sort((a, b) => b.len - a.len).map((h) => h.fragment).filter((f, i, a) => a.indexOf(f) === i);
}

/** Does this department name belong to that fragment? "ent" must be the whole word (not "Dentistry"). */
export function departmentMatches(departmentName: string, fragment: string): boolean {
  const n = normalizeText(departmentName);
  return fragment.length <= 3 ? n.split(" ").includes(fragment) : n.includes(fragment);
}

/**
 * Words that mean "this may be an emergency". The assistant then does NOT book: it tells the caller to go to the emergency
 * department or call for an ambulance at once. A booking is never the answer to an emergency (CLAUDE.md: patient safety first).
 */
const EMERGENCY = [
  "सीने में तेज दर्द", "सीने में दर्द", "सांस नहीं", "सांस लेने में तकलीफ", "साँस नहीं", "बेहोश", "खून बह रहा", "बहुत खून", "लकवा", "दौरा पड़", "ज़हर", "जहर", "आपातकाल", "इमरजेंसी",
  "chest pain", "cannot breathe", "can't breathe", "difficulty breathing", "unconscious", "heavy bleeding", "bleeding a lot", "stroke", "seizure now", "poison", "emergency",
];
export function looksLikeEmergency(text: string): boolean {
  const t = normalizeText(text);
  return EMERGENCY.some((w) => t.includes(normalizeText(w)));
}
