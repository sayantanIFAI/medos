import { editDistance, normalizeText } from "./lab-match";

export interface DoctorRef { id: string; name: string; departmentName: string | null }

const FILLER = new Set(["dr", "doctor", "डॉक्टर", "डाक्टर", "prof", "mr", "mrs", "ms"]);

/**
 * A name followed by ordinary words ("Dr. Anita Sen after 2 weeks", "Dr. Sen से 2 हफ्ते बाद"): takes the longest run of leading words
 * that names at least one doctor, so the words after the name are not mistaken for part of it.
 */
export function matchDoctorsInPhrase(phrase: string, doctors: DoctorRef[]): DoctorRef[] {
  const words = phrase.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  for (let take = words.length; take >= 1; take--) {
    const hit = matchDoctors(words.slice(0, take).join(" "), doctors);
    if (hit.length) return hit;
  }
  return [];
}

/** The doctors whose name contains every word that was said or written, allowing one letter of difference in longer words. */
export function matchDoctors(phrase: string, doctors: DoctorRef[]): DoctorRef[] {
  const want = normalizeText(phrase).split(" ").filter((w) => w.length > 1 && !FILLER.has(w));
  if (!want.length) return [];
  return doctors.filter((d) => {
    const toks = normalizeText(d.name).split(" ").filter((w) => w.length > 1 && !FILLER.has(w));
    return want.every((w) => toks.some((t) => t === w || (w.length >= 5 && editDistance(t, w, 1) <= 1) || (w.length >= 3 && t.startsWith(w))));
  });
}
