import { DomainError } from "@medos/shared";
import { SPEECH_HINTS, type FrontDeskEngine, type FrontDeskPort, type Handler, type PodClient } from "@medos/frontdesk-core";
import { z } from "zod";

const turnSchema = z.object({ text: z.string().trim().min(1).max(600), sessionId: z.string().uuid().optional(), lang: z.enum(["hi", "en"]).optional() }).strict();
const transcribeQuery = z.object({ lang: z.enum(["hi", "en"]).default("hi"), hint: z.enum(SPEECH_HINTS).default("open") });
const speakSchema = z.object({ text: z.string().trim().min(1).max(500), lang: z.enum(["hi", "en"]).default("hi") }).strict();

export interface VoicebotDeps {
  engine: FrontDeskEngine;
  pod: PodClient;
  /** The app's MedOS connection. Fails (503) when MedOS is not reachable, so the page can say so. */
  medos: () => Promise<FrontDeskPort>;
  status: () => Promise<unknown>;
}

const bad = (e: z.ZodError) => new DomainError("VALIDATION_FAILED", e.issues[0]?.message ?? "Invalid request", 400);

/**
 * The voicebot app's few routes. The page talks to these; they talk to the AI pod (listening and speaking) and to MedOS (rates, doctors,
 * free times, bookings). The words are never stored here: a conversation lives in memory for 30 minutes, the bookings live in MedOS.
 */
export function buildRoutes(d: VoicebotDeps): Record<string, Handler> {
  return {
    "GET /api/status": async () => ({ json: await d.status() }),

    "POST /api/turn": async (req) => {
      const parsed = turnSchema.safeParse(JSON.parse(req.body.toString("utf8") || "{}"));
      if (!parsed.success) throw bad(parsed.error);
      // one front desk, one conversation key: the app is a single user of MedOS
      return { json: await d.engine.turn("voicebot-app", await d.medos(), parsed.data) };
    },

    "POST /api/transcribe": async (req) => {
      const q = transcribeQuery.safeParse(Object.fromEntries(req.query));
      if (!q.success) throw bad(q.error);
      return { json: await d.pod.transcribe(req.body, req.headers["content-type"], q.data.lang, q.data.hint) };
    },

    "POST /api/speak": async (req) => {
      const parsed = speakSchema.safeParse(JSON.parse(req.body.toString("utf8") || "{}"));
      if (!parsed.success) throw bad(parsed.error);
      return { bytes: await d.pod.speak(parsed.data.text, parsed.data.lang), contentType: "audio/wav" };
    },
  };
}
