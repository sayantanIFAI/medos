import { Inject, Injectable, Logger } from "@nestjs/common";
import { FrontDeskEngine, OllamaClient, type Lang, type LlmClient, type TurnResult } from "@medos/frontdesk-core";
import { CONFIG, type AppConfig } from "../../common/config";
import type { RequestContext } from "../../common/request-context";
import { FrontDeskPorts } from "../frontdesk/prisma-port";

export type { TurnResult };

/**
 * The built-in Assistant screen. The dialogue itself lives in @medos/frontdesk-core and is the same one the separate voicebot app runs;
 * here it works with the signed-in user's own rights, straight against MedOS's services (frontdesk/prisma-port.ts).
 *
 * The one rule: the model decides what was ASKED; code decides what is TRUE. Booking needs an explicit "yes" to a read-back.
 */
@Injectable()
export class AssistantService {
  private readonly engine: FrontDeskEngine;
  /** Whether a language model is connected (the screen shows it; the assistant works from word rules without one). */
  readonly modelConfigured: boolean;

  constructor(@Inject(CONFIG) cfg: AppConfig, private readonly ports: FrontDeskPorts) {
    // the language model runs on the AI pod unless its own address is given; the pod's token goes only to the pod
    const url = cfg.ASSISTANT_LLM_URL ?? cfg.AI_REMOTE_URL;
    const llm = url ? new OllamaClient(url, cfg.ASSISTANT_LLM_MODEL, cfg.ASSISTANT_LLM_TIMEOUT_MS, url === cfg.AI_REMOTE_URL ? cfg.AI_REMOTE_TOKEN : undefined) : null;
    const log = new Logger("assistant");
    this.engine = new FrontDeskEngine(llm, { warn: (m) => log.warn(m), error: (m) => log.error(m) });
    this.modelConfigured = !!url;
  }

  /** For tests: swap in a fake model. */
  useModel(llm: LlmClient | null): void { this.engine.useModel(llm); }

  turn(ctx: RequestContext, input: { sessionId?: string; text: string; lang?: Lang }): Promise<TurnResult> {
    // a conversation belongs to the person (and hospital) who started it
    return this.engine.turn(`${ctx.tenantId}:${ctx.userId}`, this.ports.forContext(ctx), input);
  }

  /** For tests only. */
  _sessionCount(): number { return this.engine._sessionCount(); }
  _peek(id: string): unknown { return this.engine._peek(id); }
}
