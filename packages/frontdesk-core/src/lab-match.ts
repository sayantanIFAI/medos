/**
 * Finds lab tests named in free text: what a caller said (Hindi, English or a mix) or what a scanned prescription says.
 *
 * It only ever FINDS a test from the hospital's own catalogue. It never invents a name, a price or a rate, and it separates what it
 * is sure of (HIGH) from what a person should look at (MEDIUM). Only HIGH matches are ever booked automatically.
 */

export interface MatchableTest { id: string; name: string; aliases: string[] }
export interface TestMatch { testId: string; name: string; matched: string; confidence: "HIGH" | "MEDIUM"; reason: "name" | "alias" | "acronym" | "ambiguous" | "spelling" }

/** Lower case, NFKC, anything that is not a letter, a combining mark or a digit becomes a space. Works for Latin, Devanagari and Bengali. */
export function normalizeText(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

const isIndic = (s: string) => /[ऀ-ॿঀ-৿]/.test(s);
const isLatinish = (s: string) => /^[a-z0-9 ]+$/.test(s);

/** Edit distance, stopping early once it is certain to exceed `max`. */
export function editDistance(a: string, b: string, max = 1): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] as number;
}

interface Term { text: string; testId: string; kind: "name" | "alias"; acronym: boolean }

export class TestIndex {
  private readonly terms: Term[] = [];
  private readonly owners = new Map<string, Set<string>>();
  private readonly names = new Map<string, string>();

  constructor(tests: MatchableTest[]) {
    for (const t of tests) {
      this.names.set(t.id, t.name);
      const raw = [{ s: t.name, kind: "name" as const }, ...t.aliases.map((s) => ({ s, kind: "alias" as const }))];
      // a name such as "Complete Blood Count (CBC)" also answers to its parts: "complete blood count" and "cbc"
      const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(t.name);
      if (paren) { raw.push({ s: paren[1] as string, kind: "name" }, { s: paren[2] as string, kind: "alias" }); }
      for (const { s, kind } of raw) {
        const text = normalizeText(s);
        const indic = isIndic(text);
        if (indic ? [...text].length < 3 : text.replace(/ /g, "").length < 3) continue;
        const acronym = isLatinish(text) && !text.includes(" ") && text.length <= 5 && /^[A-Za-z0-9]+$/.test(s.trim());
        this.terms.push({ text, testId: t.id, kind, acronym });
        let set = this.owners.get(text);
        if (!set) { set = new Set(); this.owners.set(text, set); }
        set.add(t.id);
      }
    }
    this.terms.sort((a, b) => b.text.length - a.text.length);
  }

  /** Every test named in the text, longest phrase first, each stretch of text used once. */
  find(text: string): TestMatch[] {
    const norm = normalizeText(text);
    const rawUpper = new Set(text.normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter((w) => (w.match(/[A-Z]/g) ?? []).length >= 2).map((w) => w.toLowerCase())); // CBC, TSH, HbA1c: two or more capitals
    const used: boolean[] = new Array<boolean>(norm.length).fill(false);
    const found = new Map<string, TestMatch>();
    const keep = (m: TestMatch) => {
      const prev = found.get(m.testId);
      if (!prev || (prev.confidence === "MEDIUM" && m.confidence === "HIGH")) found.set(m.testId, m);
    };

    for (const term of this.terms) {
      let from = 0;
      for (;;) {
        const at = norm.indexOf(term.text, from);
        if (at < 0) break;
        from = at + 1;
        const end = at + term.text.length;
        const indic = isIndic(term.text);
        if (!indic) {
          const before = at === 0 ? " " : norm[at - 1];
          const after = end >= norm.length ? " " : norm[end];
          if (before !== " " || after !== " ") continue; // a whole word or phrase only
        }
        if (used.slice(at, end).some(Boolean)) continue;
        for (let i = at; i < end; i++) used[i] = true;
        const shared = (this.owners.get(term.text) ?? new Set()).size > 1;
        const owners = [...(this.owners.get(term.text) ?? [term.testId])];
        if (shared) {
          for (const id of owners) keep({ testId: id, name: this.names.get(id) as string, matched: term.text, confidence: "MEDIUM", reason: "ambiguous" });
        } else {
          // a short Latin acronym is only trusted when it is written with capitals in the text (CBC, TSH, HbA1c), not as an ordinary word
          const trusted = !term.acronym || rawUpper.has(term.text);
          keep({ testId: term.testId, name: this.names.get(term.testId) as string, matched: term.text, confidence: trusted ? "HIGH" : "MEDIUM", reason: term.acronym ? "acronym" : term.kind });
        }
      }
    }

    // spelling slips from OCR ("lipid profle"): one edit away, whole phrases of 8+ letters only, never auto-booked
    const words = norm.split(" ");
    for (const term of this.terms) {
      if (indicOrShort(term.text) || found.has(term.testId) || (this.owners.get(term.text)?.size ?? 0) > 1) continue;
      const n = term.text.split(" ").length;
      for (let i = 0; i + n <= words.length; i++) {
        const phrase = words.slice(i, i + n).join(" ");
        if (phrase !== term.text && editDistance(phrase, term.text, 1) <= 1) {
          keep({ testId: term.testId, name: this.names.get(term.testId) as string, matched: phrase, confidence: "MEDIUM", reason: "spelling" });
          break;
        }
      }
    }
    return [...found.values()];
  }
}

const indicOrShort = (t: string) => isIndic(t) || t.replace(/ /g, "").length < 8;
