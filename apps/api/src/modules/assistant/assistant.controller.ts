import { Body, Controller, Get, Headers, HttpCode, Post, Query, Req, StreamableFile } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Ctx, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { AsrService, SPEECH_HINTS } from "./asr.service";
import { AssistantService } from "./assistant.service";
import { PrescriptionScanService, scanQuerySchema } from "./scan.service";
import { TtsService } from "./tts.service";

const turnSchema = z.object({
  text: z.string().trim().min(1).max(600),
  sessionId: z.string().uuid().optional(),
  lang: z.enum(["hi", "en"]).optional(),
}).strict();

const transcribeQuerySchema = z.object({ lang: z.enum(["hi", "en"]).default("hi"), hint: z.enum(SPEECH_HINTS).default("open") }).strict();
const speakSchema = z.object({ text: z.string().trim().min(1).max(500), lang: z.enum(["hi", "en"]).default("hi") }).strict();

@Controller("assistant")
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService, private readonly scans: PrescriptionScanService,
    private readonly asr: AsrService, private readonly tts: TtsService,
  ) {}

  /** What is connected, so the screen can say so. Reveals no address or token. */
  @RequirePermissions("ASSISTANT_USE")
  @Get("capabilities")
  capabilities() {
    return { data: { voice: this.asr.available, speaking: this.asr.available, prescriptionReading: this.asr.available, model: this.assistant.modelConfigured } };
  }

  /** A reply spoken aloud (WAV audio), made on the remote AI host. */
  @RequirePermissions("ASSISTANT_USE")
  @Post("speak")
  @HttpCode(200)
  async speak(@Body() body: unknown) {
    const b = parse(speakSchema, body);
    return new StreamableFile(await this.tts.speak(b.text, b.lang), { type: "audio/wav", disposition: "inline" });
  }

  /** One spoken or typed sentence in, one reply out. The caller's words are not stored; only the bookings they lead to are, with their own audit trail. */
  @RequirePermissions("ASSISTANT_USE")
  @Post("turn")
  @HttpCode(200)
  async turn(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.assistant.turn(ctx, parse(turnSchema, body)) };
  }

  /** A short voice clip (sent as the request body) in, the words out. The clip is understood on the remote AI host and is never stored. */
  @RequirePermissions("ASSISTANT_USE")
  @Post("transcribe")
  @HttpCode(200)
  async transcribe(@Query() query: unknown, @Headers("content-type") contentType: string | undefined, @Req() req: Request) {
    const q = parse(transcribeQuerySchema, query);
    return { data: await this.asr.transcribe(req.body, contentType, q.lang, q.hint) };
  }

  /**
   * Reads a prescription (PNG, JPEG or PDF sent as the request body) on the remote AI host and works out the lab tests and follow-up visit it asks
   * for. With autoBook=true and a patient, the certain items are booked straight into MedOS; the rest come back as "needs review".
   */
  @RequirePermissions("ASSISTANT_USE", "PATIENT_READ")
  @Post("prescription-scan")
  @HttpCode(200)
  async scan(@Ctx() ctx: RequestContext, @Query() query: unknown, @Headers("content-type") _contentType: string | undefined, @Req() req: Request) {
    return { data: await this.scans.scan(ctx, parse(scanQuerySchema, query), req.body) };
  }
}
