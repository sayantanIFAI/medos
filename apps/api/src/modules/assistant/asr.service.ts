import { Inject, Injectable } from "@nestjs/common";
import { PodClient, type SpeechHint, type SpeechLang } from "@medos/frontdesk-core";
import { CONFIG, type AppConfig } from "../../common/config";

export { SPEECH_HINTS, MAX_AUDIO_BYTES, type SpeechLang, type SpeechHint } from "@medos/frontdesk-core";

/** Turns a short voice clip into text on the AI pod (the work is PodClient's). The clip is passed through and never stored. */
@Injectable()
export class AsrService {
  private readonly pod: PodClient;
  constructor(@Inject(CONFIG) cfg: AppConfig) { this.pod = new PodClient({ url: cfg.AI_REMOTE_URL, token: cfg.AI_REMOTE_TOKEN, timeoutMs: cfg.AI_REMOTE_TIMEOUT_MS }); }
  get available(): boolean { return this.pod.configured; }
  transcribe(data: unknown, contentType: string | undefined, lang: SpeechLang, hint: SpeechHint = "open") { return this.pod.transcribe(data, contentType, lang, hint); }
}
