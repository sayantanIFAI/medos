import type { RosterDoctor, VoiceBooking } from "./types";

/** The voice bot's dates and times are on the clinic's own (Kolkata) clock. India has no daylight saving, so the offset is fixed. */
const CLINIC_UTC_OFFSET = "+05:30";

export const toInstant = (date: string, slot: string): string => `${date}T${slot}:00${CLINIC_UTC_OFFSET}`;
export const startsAtMs = (b: Pick<VoiceBooking, "date" | "timeSlot">): number => Date.parse(toInstant(b.date, b.timeSlot));

/** Ten digits starting 6-9, or nothing. The voice bot's "not_provided" placeholder and half-heard numbers become "no mobile", never a wrong one. */
export function mobileOf(phone: string | null | undefined): string | undefined {
  const digits = (phone ?? "").replace(/\D/g, "").slice(-10);
  return /^[6-9]\d{9}$/.test(digits) ? digits : undefined;
}

/**
 * MedOS accepts letters, combining marks, space and . ' - in a name. A spoken Bengali name can carry joiners or stray symbols from
 * speech recognition; those are dropped rather than failing the whole booking. Nothing is invented.
 */
export function cleanName(raw: string): string {
  const kept = raw.normalize("NFC").replace(/[^\p{L}\p{M} .'’-]/gu, "").replace(/\s+/g, " ").trim().replace(/^[^\p{L}\p{M}]+/u, "");
  return kept.slice(0, 118) || "Unknown caller";
}

const SEX: Record<string, "MALE" | "FEMALE"> = { M: "MALE", F: "FEMALE" };

export function toBookingBody(b: VoiceBooking): Record<string, unknown> {
  const mobile = mobileOf(b.patient.phone);
  const address = b.patient.address.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    status: "CONFIRMED",
    doctorName: b.doctorName.slice(0, 120),
    startAt: toInstant(b.date, b.timeSlot),
    durationMinutes: Math.min(240, Math.max(5, b.slotMinutes || 10)),
    patient: {
      name: cleanName(b.patient.name),
      ...(mobile ? { mobile } : {}),
      ...(b.patient.age !== null && b.patient.age >= 0 && b.patient.age <= 130 ? { ageYears: b.patient.age } : {}),
      sex: SEX[b.patient.sex.toUpperCase()] ?? "UNKNOWN",
      ...(address ? { address } : {}),
    },
    notes: `Voice bot booking ${b.ref}`,
  };
}

/** Clinic weekdays run 0 = Monday; MedOS runs 0 = Sunday. */
export const medosWeekday = (clinicWeekday: number): number => (clinicWeekday + 1) % 7;

export function toDoctorBody(d: RosterDoctor): Record<string, unknown> {
  const windows = d.windows
    .filter((w) => w.start < w.end)
    .map((w) => ({ dayOfWeek: medosWeekday(w.weekday), start: w.start, end: w.end, slotMinutes: Math.min(120, Math.max(5, d.slotMinutes || 10)) }))
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.start.localeCompare(b.start));
  return { name: d.name.slice(0, 120), department: d.department.slice(0, 80), schedule: { windows } };
}
