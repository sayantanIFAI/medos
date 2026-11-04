import { DomainError } from "@medos/shared";
import { z } from "zod";
import { httpRequest } from "./http";
import type { OcrEngine, OcrResult } from "./scan-flow";

export type SpeechLang = "hi" | "en";
export const MAX_AUDIO_BYTES = 6 * 1024 * 1024;

/** What the assistant has just asked. Short answers ("तेरह साल", a phone number, "हाँ") are easy for a speech model to mishear, so it is told what kind of answer to expect. */
export const SPEECH_HINTS = ["open", "name", "age", "mobile", "confirm"] as const;
export type SpeechHint = (typeof SPEECH_HINTS)[number];
const SPEECH_PROMPTS: Record<SpeechHint, Record<SpeechLang, string | null>> = {
  open: { hi: null, en: null },
  // Wording only, never example answers: a speech model can repeat its prompt on a short clip, and an example would then be taken as the caller's answer.
  name: { hi: "रिसेप्शन पर मरीज़ का नाम।", en: "The patient's name at the reception desk." },
  age: { hi: "रिसेप्शन पर मरीज़ की उम्र, कितने साल।", en: "The patient's age in years at the reception desk." },
  // no hint for phone numbers: tried on the host, it made the digits worse (the model writes them as digits by itself)
  mobile: { hi: null, en: null },
  confirm: { hi: "रिसेप्शन पर बुकिंग की पुष्टि।", en: "Confirming a booking at the reception desk." },
};

export interface PodConfig { url?: string | undefined; token?: string | undefined; timeoutMs: number }

const asrAnswer = z.object({ text: z.string(), language: z.string().optional(), seconds: z.number().nullable().optional() });
const ocrAnswer = z.object({ text: z.string(), confidence: z.number(), engine: z.string().optional() });

/**
 * The one door to the AI host (the GPU pod): speech to text, spoken replies and prescription reading. Nothing here decides anything: it
 * carries bytes out and brings the host's answer back, and any failure becomes one plain "not available" error so the caller can fall back
 * to typing or booking by hand. Used by the voicebot app, the OCR app and the MedOS API alike.
 */
export class PodClient implements OcrEngine {
  constructor(private readonly cfg: PodConfig) {}

  get configured(): boolean { return !!this.cfg.url; }

  /** Headers that identify the caller to the host (a shared token; the host refuses everyone else). */
  auth(): Record<string, string> {
    return {
      ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
      "ngrok-skip-browser-warning": "1", // harmless elsewhere; stops a tunnel's interstitial page from replacing the answer
    };
  }

  /** POSTs raw bytes and returns the host's JSON answer, untyped: the caller validates it against its own schema. */
  async post(path: string, body: Buffer, contentType: string, query: Record<string, string> = {}): Promise<unknown> {
    if (!this.cfg.url) throw new DomainError("AI_SERVICE_UNAVAILABLE", "The AI service is not connected. Please do this by hand for now.", 503);
    const qs = new URLSearchParams(query).toString();
    const url = `${this.cfg.url.replace(/\/$/, "")}${path}${qs ? `?${qs}` : ""}`;
    try {
      const r = await httpRequest(url, { method: "POST", body, timeoutMs: this.cfg.timeoutMs, headers: { "content-type": contentType, ...this.auth() } });
      if (r.status < 200 || r.status >= 300) throw new Error(`AI host answered HTTP ${r.status}`);
      return JSON.parse(r.body.toString("utf8")) as unknown;
    } catch (e) {
      throw new DomainError("AI_SERVICE_UNAVAILABLE", "The AI service is not reachable right now. Please try again in a moment, or do this by hand.", 503, { reason: e instanceof Error ? e.message : "unknown" });
    }
  }

  /** POSTs JSON and returns the host's answer as bytes (spoken audio). */
  async postForBytes(path: string, json: unknown): Promise<{ data: Buffer; contentType: string }> {
    if (!this.cfg.url) throw new DomainError("AI_SERVICE_UNAVAILABLE", "The AI service is not connected.", 503);
    try {
      const r = await httpRequest(`${this.cfg.url.replace(/\/$/, "")}${path}`, { method: "POST", body: JSON.stringify(json), timeoutMs: this.cfg.timeoutMs, headers: { "content-type": "application/json", ...this.auth() } });
      if (r.status < 200 || r.status >= 300) throw new Error(`AI host answered HTTP ${r.status}`);
      return { data: r.body, contentType: r.contentType };
    } catch (e) {
      throw new DomainError("AI_SERVICE_UNAVAILABLE", "The AI service is not reachable right now.", 503, { reason: e instanceof Error ? e.message : "unknown" });
    }
  }

  /** Turns a short voice clip into text. The clip is passed through and never stored. */
  async transcribe(data: unknown, contentType: string | undefined, lang: SpeechLang, hint: SpeechHint = "open"): Promise<{ text: string; language: string | null; seconds: number | null }> {
    if (!Buffer.isBuffer(data) || data.length === 0) throw new DomainError("VALIDATION_FAILED", "Send the recording as the request body", 400);
    if (data.length > MAX_AUDIO_BYTES) throw new DomainError("PAYLOAD_TOO_LARGE", "The recording is too long. Speak in shorter parts.", 413);
    const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!type.startsWith("audio/")) throw new DomainError("VALIDATION_FAILED", "The recording must be an audio file", 400);
    const prompt = SPEECH_PROMPTS[hint][lang];
    const parsed = asrAnswer.safeParse(await this.post("/asr", data, contentType ?? type, { language: lang, ...(prompt ? { prompt } : {}) }));
    if (!parsed.success) throw new DomainError("AI_SERVICE_UNAVAILABLE", "The AI service gave an answer that could not be read. Please try again, or type instead.", 503);
    const out = parsed.data;
    return { text: out.text.replace(/\s+/g, " ").trim().slice(0, 600), language: out.language ?? null, seconds: out.seconds ?? null };
  }

  /** Speaks a reply (WAV). Only reply text the assistant itself wrote is spoken. */
  async speak(text: string, lang: SpeechLang): Promise<Buffer> {
    const { data, contentType } = await this.postForBytes("/tts", { text, language: lang });
    if (contentType !== "audio/wav" && contentType !== "audio/x-wav") throw new DomainError("AI_SERVICE_UNAVAILABLE", "The AI service could not speak this reply.", 503);
    return data;
  }

  private async read(data: Buffer, contentType: string): Promise<OcrResult> {
    const parsed = ocrAnswer.safeParse(await this.post("/ocr", data, contentType, { lang: "hi,en" }));
    if (!parsed.success) throw new DomainError("AI_SERVICE_UNAVAILABLE", "The AI service gave an answer that could not be read. Please try again, or book by hand.", 503);
    const out = parsed.data;
    return { text: out.text, confidence: Math.max(0, Math.min(100, Math.round(out.confidence))), engine: out.engine ? `remote-${out.engine}` : "remote" };
  }

  readImage(data: Buffer, contentType = "image/png"): Promise<OcrResult> { return this.read(data, contentType); }
  readPdf(data: Buffer): Promise<OcrResult> { return this.read(data, "application/pdf"); }
}
