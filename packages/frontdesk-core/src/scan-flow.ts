import { DomainError } from "@medos/shared";
import { createHash } from "node:crypto";
import { departmentMatches } from "./departments";
import { planPrescription, type PlannedTest, type PlannedVisit } from "./prescription.parser";
import type { FrontDeskPort } from "./port";
import { localDateStr, zonedToUtc } from "./time";

export const MAX_SCAN_BYTES = 5 * 1024 * 1024;
/** Below this reading confidence nothing is booked automatically: a blurry photo is retaken, not guessed at. */
export const MIN_AUTO_CONFIDENCE = 55;
const SEARCH_DAYS = 14;

export interface OcrResult { text: string; confidence: number; engine: string }
export interface OcrEngine {
  readImage(data: Buffer, contentType?: string): Promise<OcrResult>;
  readPdf(data: Buffer): Promise<OcrResult>;
}

export type ScanKind = "image/png" | "image/jpeg" | "application/pdf";
export function sniffKind(b: Buffer): ScanKind | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

export interface ScanResult {
  reading: { engine: string; confidence: number; unclear: boolean; text: string };
  tests: PlannedTest[];
  visits: (PlannedVisit & { booked: boolean })[];
  booked: {
    lab: { id: string; reference: string; total: string; collectionAt: string; tests: string[] } | null;
    appointments: { id: string; reference: string; doctor: string; startAt: string }[];
  };
  needsReview: { what: string; reason: string }[];
  fileId: string | null;
  autoBook: boolean;
}

export interface ScanOptions { patientId?: string | undefined; autoBook: boolean; filename: string }

const shortRef = (id: string) => id.slice(0, 8).toUpperCase();

/**
 * A scanned prescription becomes lab bookings and follow-up appointments. The picture is read by the OCR engine (on the AI pod), the plan
 * is made from the hospital's own catalogue and doctors, and only what is certain is booked: a blurry photo, a spelling that is not exact
 * or a visit with no time is listed for staff instead. Booking happens only when asked (autoBook) and only with the connected user's rights.
 */
export async function scanPrescription(port: FrontDeskPort, ocr: OcrEngine, data: unknown, q: ScanOptions): Promise<ScanResult> {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new DomainError("VALIDATION_FAILED", "Send the prescription as a PNG, JPEG or PDF file", 400);
  if (data.length > MAX_SCAN_BYTES) throw new DomainError("PAYLOAD_TOO_LARGE", "The file is larger than 5 MB", 413);
  const kind = sniffKind(data);
  if (!kind) throw new DomainError("VALIDATION_FAILED", "The file is not a PNG, JPEG or PDF", 400);
  if (q.autoBook && !q.patientId) throw new DomainError("VALIDATION_FAILED", "Choose the patient before booking automatically", 400, [{ path: "patientId", message: "Required with autoBook" }]);

  const tz = await port.timezone();
  const today = localDateStr(new Date(), tz);
  if (q.patientId && !(await port.patientExists(q.patientId))) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);

  // 1. read it
  const read = kind === "application/pdf" ? await ocr.readPdf(data) : await ocr.readImage(data, kind);
  const text = read.text.replace(/\u0000/g, "").trim();
  const unclear = read.confidence < MIN_AUTO_CONFIDENCE || text.length < 10;

  // 2. work out what it asks for, from the hospital's own catalogue and doctors
  const [matches, docs, depts] = await Promise.all([port.findTests(text), port.doctors(), port.departments()]);
  const plan = planPrescription(text, matches, docs.map((d) => ({ id: d.id, name: d.name, departmentName: d.departmentName })), depts);

  const result: ScanResult = {
    reading: { engine: read.engine, confidence: read.confidence, unclear, text: text.slice(0, 4000) },
    tests: plan.tests, visits: plan.visits.map((v) => ({ ...v, booked: false })), booked: { lab: null, appointments: [] }, needsReview: [], fileId: null, autoBook: q.autoBook,
  };
  if (unclear) result.needsReview.push({ what: "the whole prescription", reason: "The reading is not clear enough to book from. Please retake the photo, or book by hand." });
  for (const item of plan.unmatched) result.needsReview.push({ what: `${item} (listed under investigations)`, reason: "No test in your lab catalogue matches this. Add it to the catalogue, or book it by hand." });
  for (const t of plan.tests.filter((x) => x.confidence === "MEDIUM")) result.needsReview.push({ what: `${t.name} (read as "${t.matched}")`, reason: t.reason === "ambiguous" ? "More than one test fits this word. Choose the right one." : "The spelling is not exact. Please check it against the paper." });
  for (const v of plan.visits.filter((x) => x.confidence === "MEDIUM")) result.needsReview.push({ what: v.evidence, reason: `Follow-up or referral found, but ${v.why}.` });

  // 3. book what is certain, only when asked to, and only with the connected user's own rights
  if (q.autoBook && q.patientId && !unclear) {
    // Repeat detection is per patient AND image: the same paper scanned for someone else is a different booking, never a replay.
    const key = createHash("sha256").update(data).update(`:${q.patientId}`).digest("hex");
    const needFile = plan.tests.some((t) => t.confidence === "HIGH") || plan.visits.some((v) => v.confidence === "HIGH");
    if (needFile && port.can("PATIENT_UPDATE")) {
      result.fileId = (await port.storePrescription({ patientId: q.patientId, filename: q.filename, contentType: kind, data })).fileId;
    }
    const high = plan.tests.filter((t) => t.confidence === "HIGH");
    if (high.length) {
      if (!port.can("LAB_BOOK")) result.needsReview.push({ what: "lab tests", reason: "Your account cannot book lab tests." });
      else {
        const picks = await port.labTests(high.map((t) => t.testId));
        const fasting = picks.some((t) => t.fastingRequired);
        const tomorrow = localDateStr(new Date(zonedToUtc(today, 12 * 60, tz).getTime() + 86_400_000), tz);
        const at = zonedToUtc(tomorrow, fasting ? 8 * 60 : 10 * 60, tz);
        const booking = await port.bookLab({ patientId: q.patientId, testIds: high.map((t) => t.testId), collectionAt: at.toISOString(), homeCollection: false, notes: "Booked from a scanned prescription", source: "PRESCRIPTION", fileId: result.fileId, idempotencyKey: `scan:${key.slice(0, 32)}` });
        result.booked.lab = { id: booking.id, reference: shortRef(booking.id), total: booking.totalAmount, collectionAt: new Date(booking.collectionAt).toISOString(), tests: booking.items };
      }
    }
    for (const [i, v] of result.visits.entries()) {
      if (v.confidence !== "HIGH") continue;
      if (!port.can("APPOINTMENT_CREATE")) { result.needsReview.push({ what: v.evidence, reason: "Your account cannot book appointments." }); continue; }
      const slot = await earliest(port, v, today, tz);
      if (!slot) { result.needsReview.push({ what: v.evidence, reason: "No free appointment was found in the next two weeks. Please book by hand." }); continue; }
      const appt = await port.bookAppointment({ patientId: q.patientId, doctorId: slot.doctor.id, startAt: slot.startAt.toISOString(), durationMinutes: slot.minutes, externalRef: `SCAN-${key.slice(0, 10)}-${i + 1}`, source: "PRESCRIPTION", fileId: result.fileId, notes: "Booked from a scanned prescription" });
      v.booked = true;
      result.booked.appointments.push({ id: appt.id, reference: shortRef(appt.id), doctor: slot.doctor.name, startAt: slot.startAt.toISOString() });
    }
  }

  await port.recordScan({
    patientId: q.patientId ?? null,
    metadata: { engine: read.engine, confidence: read.confidence, tests: plan.tests.length, visits: plan.visits.length, autoBook: q.autoBook, labBooked: !!result.booked.lab, appointmentsBooked: result.booked.appointments.length, needsReview: result.needsReview.length, fileId: result.fileId },
  });
  return result;
}

/** The doctor and slot with the earliest free time on or after the date asked for: the named doctor, or any doctor of the named department. */
async function earliest(port: FrontDeskPort, v: PlannedVisit, today: string, tz: string): Promise<{ doctor: { id: string; name: string }; startAt: Date; minutes: number } | null> {
  const from = localDateStr(new Date(zonedToUtc(today, 12 * 60, tz).getTime() + v.afterDays * 86_400_000), tz);
  const all = await port.doctors();
  let candidates: { id: string; name: string }[] = [];
  if (v.doctorId) {
    const d = all.find((x) => x.id === v.doctorId);
    if (d) candidates = [{ id: d.id, name: d.name }];
  } else if (v.departmentFragment) {
    candidates = all.filter((r) => r.departmentName && departmentMatches(r.departmentName, v.departmentFragment as string)).slice(0, 12).map((r) => ({ id: r.id, name: r.name }));
  }
  let best: { doctor: { id: string; name: string }; startAt: Date; minutes: number } | null = null;
  for (const c of candidates) {
    for (let i = 0; i < SEARCH_DAYS; i++) {
      const day = localDateStr(new Date(zonedToUtc(from, 12 * 60, tz).getTime() + i * 86_400_000), tz);
      const free = (await port.availability(c.id, day)).filter((s) => s.available);
      const first = free[0];
      if (first) {
        const startAt = new Date(first.startAt);
        if (!best || startAt < best.startAt) best = { doctor: c, startAt, minutes: Math.round((Date.parse(first.endAt) - Date.parse(first.startAt)) / 60_000) };
        break;
      }
    }
  }
  return best;
}
