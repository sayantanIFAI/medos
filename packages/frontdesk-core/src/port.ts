import type { TestMatch } from "./lab-match";

/** A catalogue match with the hospital's current rate. */
export type PricedTestMatch = TestMatch & { price: string };

/** One lab test as the assistant needs it: the rate, the wait and the preparation, all from MedOS. */
export interface LabPick { id: string; name: string; price: string; reportHours: number; fastingRequired: boolean; prepEn: string | null; prepHi: string | null }
export interface DoctorPick { id: string; name: string; departmentName: string | null }
export interface Slot { startAt: string; endAt: string; available: boolean }
export type Sex = "MALE" | "FEMALE" | "UNKNOWN";
/** Which app made a booking: the voicebot app is VOICE_ASSISTANT, the OCR app is PRESCRIPTION. MedOS shows it on the patient's journey. */
export type BookingSource = "VOICE_ASSISTANT" | "PRESCRIPTION";

export interface PatientInput { name: string; mobile?: string | undefined; ageYears?: number | undefined; sex: Sex }
export interface LabBookingInput { patientId: string; testIds: string[]; collectionAt: string; homeCollection: boolean; idempotencyKey: string; source: BookingSource; fileId?: string | null; notes?: string }
export interface LabBookingOut { id: string; totalAmount: string; collectionAt: string; items: string[] }
export interface AppointmentInput { patientId: string; doctorId: string; startAt: string; durationMinutes: number; externalRef: string; source: BookingSource; fileId?: string | null; notes?: string }
export interface AppointmentOut { id: string }

/**
 * Everything the voicebot and the OCR reader may ask of MedOS. MedOS decides what is true (rates, doctors, free times, booking numbers) and
 * enforces permissions, tenant isolation, audit and idempotency; the apps only ask. Two implementations exist: HTTP calls to MedOS
 * (medos-client.ts, used by the apps) and direct database calls (inside the MedOS API, for the built-in screen).
 */
export interface FrontDeskPort {
  /** Whether the connected MedOS user holds this permission (an app told to book without it is refused by MedOS as well). */
  can(permission: string): boolean;
  timezone(): Promise<string>;
  /** Lab tests named in free text, from the hospital's own catalogue (names, aliases, spelling). */
  findTests(text: string): Promise<PricedTestMatch[]>;
  labTests(ids: string[]): Promise<LabPick[]>;
  doctors(): Promise<DoctorPick[]>;
  departments(): Promise<string[]>;
  availability(doctorId: string, date: string): Promise<Slot[]>;
  /** Finds the returning caller (same mobile and first name) or registers a new patient. Never merges patients. Repeating a ref returns the same patient. */
  resolvePatient(ref: string, patient: PatientInput): Promise<{ patientId: string; mrn: string | null }>;
  patientExists(patientId: string): Promise<boolean>;
  /** A repeat with the same idempotencyKey returns the first booking. */
  bookLab(input: LabBookingInput): Promise<LabBookingOut>;
  /** A repeat with the same externalRef returns the first appointment. */
  bookAppointment(input: AppointmentInput): Promise<AppointmentOut>;
  /** Keeps the scanned prescription with the patient. Storing the same picture for the same patient again returns the same file. */
  storePrescription(input: { patientId: string; filename: string; contentType: string; data: Buffer }): Promise<{ fileId: string }>;
  /** One audit line for a scan (counts only, never the prescription text). */
  recordScan(input: { patientId: string | null; metadata: Record<string, unknown> }): Promise<void>;
}
