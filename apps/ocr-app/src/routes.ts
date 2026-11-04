import { DomainError } from "@medos/shared";
import { scanPrescription, type Handler, type MedosClient, type OcrEngine } from "@medos/frontdesk-core";
import { z } from "zod";
import { guessPatientName } from "./guess";

const scanQuery = z.object({ patientId: z.string().uuid().optional(), autoBook: z.enum(["true", "false"]).default("false"), filename: z.string().trim().max(120).default("prescription") });
const searchQuery = z.object({ q: z.string().trim().min(2).max(60) });

export interface OcrAppDeps {
  ocr: OcrEngine;
  /** The app's MedOS connection. Fails (503) when MedOS is not reachable, so the page can say so. */
  medos: () => Promise<MedosClient>;
  status: () => Promise<unknown>;
}

const bad = (e: z.ZodError) => new DomainError("VALIDATION_FAILED", e.issues[0]?.message ?? "Invalid request", 400);

/**
 * The OCR app's routes. The picture goes to the AI pod to be read; the rules for what a prescription asks for, and every booking, are the
 * shared front-desk code and MedOS. "read" only shows what was found (nothing is booked); "scan" with a chosen patient and autoBook books
 * what is certain and lists the rest for staff.
 */
export function buildRoutes(d: OcrAppDeps): Record<string, Handler> {
  return {
    "GET /api/status": async () => ({ json: await d.status() }),

    /** Read the paper and show what it asks for. Books nothing and needs no patient. */
    "POST /api/read": async (req) => {
      const q = scanQuery.safeParse(Object.fromEntries(req.query));
      if (!q.success) throw bad(q.error);
      const result = await scanPrescription(await d.medos(), d.ocr, req.body, { autoBook: false, filename: q.data.filename });
      return { json: { ...result, patientGuess: guessPatientName(result.reading.text) } };
    },

    "GET /api/patients": async (req) => {
      const q = searchQuery.safeParse(Object.fromEntries(req.query));
      if (!q.success) throw bad(q.error);
      return { json: await (await d.medos()).searchPatients(q.data.q) };
    },

    /** Read the paper for a chosen patient and, when asked, book what is certain. */
    "POST /api/scan": async (req) => {
      const q = scanQuery.safeParse(Object.fromEntries(req.query));
      if (!q.success) throw bad(q.error);
      const result = await scanPrescription(await d.medos(), d.ocr, req.body, { patientId: q.data.patientId, autoBook: q.data.autoBook === "true", filename: q.data.filename });
      return { json: result };
    },
  };
}
