/**
 * Names are written in Devanagari by the voicebot (a spoken Hindi name) and in English letters on most prescriptions ("pavan" and "पवन" are the
 * same person). To find one from the other, both are reduced to a rough sound skeleton: the consonants, with aspirated and look-alike sounds
 * folded together and every vowel dropped, so "pavan", "pawan" and "पवन" all become "pvn", and "kumar", "Kumaar" and "कुमार" become "kmr".
 *
 * It is a way to FIND candidates for a person at the desk to choose from. It never decides that two records are the same patient.
 */
const DEVANAGARI: Record<string, string> = {
  क: "k", ख: "k", ग: "g", घ: "g", ङ: "n", च: "c", छ: "c", ज: "j", झ: "j", ञ: "n", ट: "t", ठ: "t", ड: "d", ढ: "d", ण: "n", त: "t", थ: "t", द: "d", ध: "d", न: "n",
  प: "p", फ: "p", ब: "b", भ: "b", म: "m", य: "", र: "r", ल: "l", व: "v", श: "s", ष: "s", स: "s", ह: "", ळ: "l", क़: "k", ख़: "k", ग़: "g", ज़: "j", ड़: "r", ढ़: "r", फ़: "p",
};

function fromDevanagari(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    if (ch === "क्ष") out += "ks";
    else out += DEVANAGARI[ch] ?? (/[ऀ-ॿ]/.test(ch) ? "" : ch);
  }
  return out.replace(/ज्ञ/g, "gy");
}

function fromLatin(s: string): string {
  return s
    .toLowerCase()
    .replace(/chh?/g, "C").replace(/[ksgjbdt]h/g, (m) => m[0] as string).replace(/ph/g, "p").replace(/sh/g, "s")
    .replace(/ck/g, "k").replace(/q/g, "k").replace(/x/g, "ks").replace(/c/g, "k").replace(/f/g, "p").replace(/[wv]/g, "v").replace(/z/g, "j")
    .replace(/C/g, "c").replace(/[^a-z]/g, "").replace(/[aeiouyh]/g, "");
}

/** The sound skeleton of one word (letters of any script mixed are handled word by word). */
export function phoneticKey(word: string): string {
  const key = /[ऀ-ॿ]/.test(word) ? fromLatin(fromDevanagari(word)) : fromLatin(word);
  return key.replace(/(.)\1+/g, "$1");
}

const words = (s: string): string[] => s.split(/[\s.,;:'"()\-_/]+/).filter(Boolean);

/**
 * Whether every word typed matches the start of some word in the full name by sound, across scripts. Words shorter than three letters
 * must match exactly, so "ra" does not match every name; a query with no usable sound never matches.
 */
export function nameMatchesBySound(query: string, fullName: string): boolean {
  const q = words(query);
  if (q.length === 0) return false;
  const name = words(fullName).map(phoneticKey).filter(Boolean);
  if (name.length === 0) return false;
  return q.every((w) => {
    const k = phoneticKey(w);
    if (!k) return false;
    return name.some((n) => (w.length >= 3 && k.length >= 2 ? n.startsWith(k) : n === k));
  });
}
