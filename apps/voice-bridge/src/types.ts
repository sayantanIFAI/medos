/** One doctor appointment the voice bot has confirmed, as read from its booking log. */
export interface VoiceBooking {
  /** The voice bot's confirmation number, e.g. KCD-20261110-AB12CD34. The key for everything in MedOS. */
  ref: string;
  /** The doctor exactly as the voice bot's log spells him or her (its log carries no doctor id). */
  doctorName: string;
  department: string;
  /** ISO date and "HH:MM", both on the clinic's (Asia/Kolkata) clock */
  date: string;
  timeSlot: string;
  slotMinutes: number;
  patient: { name: string; age: number | null; sex: string; address: string; phone: string };
}

/**
 * The pod, read-only. Both calls only READ what the voice bot already writes: its booking log file, and its own lookup endpoint.
 * Nothing is installed, changed or restarted there.
 */
export interface PodLike {
  /** Complete new lines of the booking log after byte `offset`, and the offset to continue from. */
  readLog(offset: number): Promise<{ bookings: VoiceBooking[]; next: number }>;
  /** Which of these confirmation numbers the clinic API still holds as confirmed. Throws TransientError when it cannot tell. */
  stillConfirmed(refs: string[]): Promise<Set<string>>;
}

/** MedOS's reply to a call. `status` 2xx means recorded; a 4xx is a decision the bridge must not retry blindly. */
export interface MedosReply {
  status: number;
  body: { data?: Record<string, unknown>; error?: { code: string; message: string } };
}

export interface MedosLike {
  putDoctor(ref: string, body: unknown): Promise<MedosReply>;
  putBooking(ref: string, body: unknown): Promise<MedosReply>;
  cancelBooking(ref: string, reason: string): Promise<MedosReply>;
}

/** A doctor in the demo roster file (apps/voice-bridge/data/kcd-doctors.json). Weekday 0 = Monday. */
export interface RosterDoctor {
  ref: string;
  name: string;
  department: string;
  slotMinutes: number;
  windows: { weekday: number; start: string; end: string }[];
}

/** Thrown for a failure worth retrying later (network, 5xx, an answer that could not be read). */
export class TransientError extends Error {}
