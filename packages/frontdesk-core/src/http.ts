import * as http from "node:http";
import * as https from "node:https";

/**
 * Calls to the AI pod go through a tunnel to another region, so every new connection costs several round trips (about 0.3 to 0.5 s here).
 * These agents keep connections open between calls (a voice turn makes three), so only the first call of a conversation pays that cost.
 * The pod keeps its side open for two minutes (`--timeout-keep-alive 120`).
 */
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 8 });

export interface HttpResult { status: number; contentType: string; body: Buffer }

/** One HTTP request on a kept-alive connection. Rejects on network errors and timeouts; the status is the caller's to judge. */
export function httpRequest(url: string, opts: { method: string; headers?: Record<string, string>; body?: Buffer | string; timeoutMs: number }): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const body = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body);
    const req = mod.request(u, {
      method: opts.method, agent: u.protocol === "https:" ? httpsAgent : httpAgent,
      headers: { ...(opts.headers ?? {}), ...(body ? { "content-length": String(body.length) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "", body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`no answer within ${opts.timeoutMs} ms`)));
    req.on("error", reject);
    req.end(body);
  });
}
