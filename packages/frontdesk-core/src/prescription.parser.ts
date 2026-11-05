import { departmentFragments } from "./departments";
import { matchDoctorsInPhrase, type DoctorRef } from "./doctors.match";
import { normalizeText, type TestMatch } from "./lab-match";
import { spokenNumber } from "./spoken";

/**
 * Reads what a prescription ASKS FOR: lab tests, and a follow-up or referral visit. It does not read medicines, doses or diagnoses and
 * never decides anything clinical. Every item carries the line it came from, so a person can check it against the paper, and only
 * items marked HIGH are ever booked automatically; the rest are handed to staff as "needs review".
 */
export interface PlannedTest { testId: string; name: string; price: string; matched: string; confidence: "HIGH" | "MEDIUM"; reason: string }
export interface PlannedVisit {
  kind: "FOLLOW_UP" | "REFERRAL";
  doctorId: string | null; doctorName: string | null; departmentFragment: string | null;
  /** Days from the date of the prescription (today); 0 means as soon as possible. */
  afterDays: number;
  confidence: "HIGH" | "MEDIUM";
  evidence: string;
  why: string;
}
export interface PrescriptionPlan {
  tests: PlannedTest[]; visits: PlannedVisit[];
  /** Things listed under investigations that matched no test in the hospital's catalogue (for example a "fever profile" bundle it does not have), so a person sees them instead of nothing. */
  unmatched: string[];
}

// "consult" must not match "Consultant" (a signature line on many forms)
const CLUE = /(?:follow[\s-]?up|review|re-?visit|come\s+(?:back|again)|show\s+again|next\s+visit|refer(?:red)?\s+to|referral|consult(?!ant)|फॉलो\s?अप|फिर\s+दिखा|दोबारा|दुबारा|वापस\s+आ|रेफर|परामर्श|दिखाएँ|दिखाएं)/iu;
const REFER = /(?:refer(?:red)?\s+to|referral|consult(?!ant)|रेफर|परामर्श)/iu;

/** A form label with nothing filled in ("Next Follow Up: —", "Consultant Signature: [?]"), or a signature or stamp line: not a request for anything. */
function isEmptyOrSignature(line: string): boolean {
  if (/signature|signed|stamp|reg(?:istration)?\.?\s*no|हस्ताक्षर/iu.test(line)) return true;
  const colon = line.indexOf(":");
  if (colon < 0) return false;
  return line.slice(colon + 1).replace(/\[\?\]|[\s\-–—_.?*|]/gu, "") === "";
}

const INVESTIGATION_LABEL = /^\s*(?:investigations?(?:\s+advised)?|inv\.?|tests?(?:\s+advised)?|lab(?:\s+tests?)?|advised|adv\.?|जांच|जाँच|परीक्षण)\b[^:\n]*:\s*(.*)$/iu;

/** The items written under an "Investigation(s)" heading, on the same line or on the lines that follow it. */
function investigationItems(lines: string[]): string[] {
  const items: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = INVESTIGATION_LABEL.exec(lines[i] as string);
    if (!m) continue;
    const chunks: string[] = [m[1] ?? ""];
    for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
      const next = (lines[j] as string).trim();
      if (!next || /^(?:rx|℞)(?![\p{L}])/iu.test(next) || /^[^:\n]{1,25}:/u.test(next)) break; // the next section starts
      chunks.push(next);
    }
    for (const c of chunks) {
      for (const part of c.split(/,|;|\+|&|\band\b|और/iu)) {
        const item = part.replace(/^[\s\d.)\-•*]+/u, "").replace(/[?\s.]+$/u, "").trim();
        if (item.length >= 3 && !/^(?:nil|none|no|n\/a)\b/iu.test(item) && item.replace(/\[\?\]/gu, "").trim().length >= 3) items.push(item);
      }
    }
  }
  return [...new Set(items)];
}
const UNIT_DAYS: Record<string, number> = { day: 1, days: 1, दिन: 1, week: 7, weeks: 7, हफ्ते: 7, हफ़्ते: 7, हफ्ता: 7, सप्ताह: 7, month: 30, months: 30, महीने: 30, महीना: 30, माह: 30 };

function intervalDays(line: string): number | null {
  const m = /(?:after|in|within|बाद|में)?\s*(\d{1,2}|[^\s\d]+)\s*(days?|weeks?|months?|दिन|हफ्ते|हफ़्ते|हफ्ता|सप्ताह|महीने|महीना|माह)/iu.exec(line);
  if (m) {
    const n = /^\d+$/.test(m[1] as string) ? Number(m[1]) : spokenNumber(m[1] as string);
    const unit = UNIT_DAYS[(m[2] as string).toLowerCase()];
    if (n !== null && n >= 1 && unit) return n * unit;
  }
  if (/next\s+week|अगले\s+हफ्ते|अगले\s+सप्ताह/iu.test(line)) return 7;
  if (/next\s+month|अगले\s+महीने/iu.test(line)) return 30;
  if (/tomorrow|कल/iu.test(line)) return 1;
  return null;
}

export function planPrescription(
  text: string,
  testMatches: (TestMatch & { price: string })[],
  doctors: DoctorRef[],
  departmentNames: string[],
): PrescriptionPlan {
  const tests: PlannedTest[] = testMatches.map((m) => ({ testId: m.testId, name: m.name, price: m.price, matched: m.matched, confidence: m.confidence, reason: m.reason }));

  const visits: PlannedVisit[] = [];
  // a sentence ends at a line break, or at a full stop that is not the one in "Dr." or "Mr."
  const lines = text.split(/\r?\n|(?<=[.;])(?<!\b(?:Dr|Mr|Mrs|Ms|Prof)\.)\s+/u).map((l) => l.trim()).filter((l) => l.length >= 4);
  for (const line of lines) {
    if (!CLUE.test(line) || isEmptyOrSignature(line)) continue;
    const evidence = line.length > 140 ? `${line.slice(0, 137)}...` : line;
    const afterDays = intervalDays(line);
    const refer = REFER.test(line);

    // a doctor named on the line ("Dr. Anita Sen"), matched to the hospital's own doctors
    const named = /(?:Dr\.?|Doctor|डॉ\.?|डॉक्टर)\s+([A-Za-zऀ-ॿ][A-Za-zऀ-ॿ.\- ]{2,40})/u.exec(line);
    const found = named ? matchDoctorsInPhrase(named[1] as string, doctors) : [];
    if (found.length === 1) {
      const d = found[0] as DoctorRef;
      visits.push({ kind: refer ? "REFERRAL" : "FOLLOW_UP", doctorId: d.id, doctorName: d.name, departmentFragment: null, afterDays: afterDays ?? 0, confidence: afterDays !== null || refer ? "HIGH" : "MEDIUM", evidence, why: afterDays !== null || refer ? "doctor named" : "doctor named but no time given" });
      continue;
    }
    if (found.length > 1) { visits.push({ kind: refer ? "REFERRAL" : "FOLLOW_UP", doctorId: null, doctorName: null, departmentFragment: null, afterDays: afterDays ?? 0, confidence: "MEDIUM", evidence, why: "more than one doctor has this name" }); continue; }

    const frags = departmentFragments(line).filter((f) => departmentNames.some((n) => normalizeText(n).includes(f) || (f.length <= 3 && normalizeText(n).split(" ").includes(f))));
    if (frags.length === 1) {
      visits.push({ kind: refer ? "REFERRAL" : "FOLLOW_UP", doctorId: null, doctorName: null, departmentFragment: frags[0] as string, afterDays: afterDays ?? 0, confidence: refer || afterDays !== null ? "HIGH" : "MEDIUM", evidence, why: refer || afterDays !== null ? "department named" : "department named but no time given" });
      continue;
    }
    // a follow-up with no doctor and no department: the patient's own doctor is not known from the paper
    visits.push({ kind: refer ? "REFERRAL" : "FOLLOW_UP", doctorId: null, doctorName: null, departmentFragment: null, afterDays: afterDays ?? 0, confidence: "MEDIUM", evidence, why: "no doctor or department on the line" });
  }
  const covered = tests.map((t) => normalizeText(t.matched)).filter(Boolean);
  const unmatched = investigationItems(text.split(/\r?\n/u)).filter((item) => {
    const n = normalizeText(item);
    return n.length >= 3 && !covered.some((c) => n.includes(c) || c.includes(n));
  });
  return { tests, visits, unmatched };
}
