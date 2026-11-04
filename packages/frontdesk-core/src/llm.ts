import { httpRequest } from "./http";

/**
 * The language model, behind a small interface. It is used for ONE job: turning what a caller said (Hindi, English or a mix) into a
 * structured request. It never answers the caller, never states a price, a time or a name from memory, and its output is checked
 * against a schema before anything uses it (see nlu.ts and CLAUDE.md "the model may decide what the caller wants, never what is true").
 */
export interface LlmClient {
  /** Returns the model's JSON text for the given system and user messages, or throws if it cannot. */
  completeJson(system: string, user: string, schema: Record<string, unknown>): Promise<string>;
}

/** An Ollama-compatible chat endpoint: the Qwen2.5 model the remote AI host (Kaggle notebook) serves, or any other Ollama. */
export class OllamaClient implements LlmClient {
  constructor(private readonly baseUrl: string, private readonly model: string, private readonly timeoutMs: number, private readonly token?: string) {}

  async completeJson(system: string, user: string, schema: Record<string, unknown>): Promise<string> {
    const r = await httpRequest(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST", timeoutMs: this.timeoutMs,
      headers: { "content-type": "application/json", "ngrok-skip-browser-warning": "1", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({
        model: this.model, stream: false, format: schema, keep_alive: "30m",
        options: { temperature: 0, num_predict: 400 },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`language model answered HTTP ${r.status}`);
    const j = JSON.parse(r.body.toString("utf8")) as { message?: { content?: string } };
    const content = j.message?.content;
    if (!content) throw new Error("language model gave an empty answer");
    return content;
  }
}
