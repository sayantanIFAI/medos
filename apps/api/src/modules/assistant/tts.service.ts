import { Inject, Injectable } from "@nestjs/common";
import { PodClient, type SpeechLang } from "@medos/frontdesk-core";
import { CONFIG, type AppConfig } from "../../common/config";

/** Turns a reply into spoken audio on the AI pod (the work is PodClient's). Only reply text MedOS itself wrote is spoken; nothing is stored. */
@Injectable()
export class TtsService {
  private readonly pod: PodClient;
  constructor(@Inject(CONFIG) cfg: AppConfig) { this.pod = new PodClient({ url: cfg.AI_REMOTE_URL, token: cfg.AI_REMOTE_TOKEN, timeoutMs: cfg.AI_REMOTE_TIMEOUT_MS }); }
  speak(text: string, lang: SpeechLang): Promise<Buffer> { return this.pod.speak(text, lang); }
}
