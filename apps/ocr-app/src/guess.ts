/**
 * The name written after "Patient" (or "Name", "रोगी", "मरीज़") on a prescription, only to start the search for the patient in MedOS.
 * It is a hint for staff, never a decision: the person at the desk chooses the patient, and nothing is booked for a guessed name.
 */
export function guessPatientName(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /(?:patient(?:'s)?(?:\s+name)?|pt\.?|name|रोगी|मरीज़|मरीज)\s*[:\-–]\s*([\p{L}\p{M}][\p{L}\p{M} .'-]{1,60}?)(?=\s{2,}|\s+(?:age|sex|gender|date|dob|उम्र|आयु|दिनांक|तारीख)\b|\s*[,;|]|$)/iu.exec(line);
    if (m?.[1]) {
      const name = m[1].replace(/\s+/g, " ").replace(/^(?:mr|mrs|ms|master|baby|smt|shri|sri)\.?\s+/i, "").trim();
      if (name.length >= 2) return name;
    }
  }
  return null;
}
