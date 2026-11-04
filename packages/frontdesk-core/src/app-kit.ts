import { DomainError } from "@medos/shared";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

/** Reads KEY=VALUE lines from a file into process.env (values already set in the environment win). A missing file is fine. */
export function loadEnvFile(file: string): void {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1] as string] === undefined) process.env[m[1] as string] = (m[2] as string).replace(/^"(.*)"$/, "$1");
  }
}

export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} (in the app's env file under .local, see apps/*/README.md)`);
  return v;
}

export interface AppRequest { method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: Buffer }
export interface AppResponse { status?: number; json?: unknown; bytes?: Buffer; contentType?: string }
export type Handler = (req: AppRequest) => Promise<AppResponse>;

export interface AppServerOptions {
  /** Routes keyed "METHOD /path", e.g. "POST /api/turn". */
  routes: Record<string, Handler>;
  /** Folder with the app's page (index.html and friends). */
  staticDir: string;
  maxBodyBytes?: number;
  log?: (message: string) => void;
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

/**
 * A tiny local web server for one of the apps: its page plus a few JSON routes. It is meant for the person at this computer only:
 * it refuses any Host that is not this machine (so another website cannot reach it through DNS tricks), and every POST must carry the
 * app's own header, which a page from another origin cannot add without a permission check the server never grants.
 */
export function createAppServer(opts: AppServerOptions): http.Server {
  const max = opts.maxBodyBytes ?? 8 * 1024 * 1024;
  const log = opts.log ?? (() => undefined);
  const send = (res: http.ServerResponse, status: number, type: string, body: Buffer | string) => { res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY" }); res.end(body); };

  return http.createServer((req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) { send(res, 403, "text/plain", "This app only answers on this computer."); return; }
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = (req.method ?? "GET").toUpperCase();
    const handler = opts.routes[`${method} ${url.pathname}`];

    const chunks: Buffer[] = []; let size = 0; let tooBig = false;
    req.on("data", (c: Buffer) => { size += c.length; if (size > max) tooBig = true; else chunks.push(c); });
    req.on("end", () => {
      void (async () => {
        try {
          if (!handler) {
            if (method !== "GET") { send(res, 404, "application/json", JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } })); return; }
            const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
            const file = path.resolve(opts.staticDir, rel);
            if (!file.startsWith(path.resolve(opts.staticDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { send(res, 404, "text/plain", "Not found"); return; }
            send(res, 200, TYPES[path.extname(file)] ?? "application/octet-stream", fs.readFileSync(file));
            return;
          }
          if (method !== "GET" && req.headers["x-medos-app"] !== "1") { send(res, 403, "application/json", JSON.stringify({ error: { code: "FORBIDDEN", message: "Missing app header" } })); return; }
          if (tooBig) { send(res, 413, "application/json", JSON.stringify({ error: { code: "PAYLOAD_TOO_LARGE", message: "The upload is too large" } })); return; }
          const out = await handler({ method, path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks) });
          if (out.bytes) send(res, out.status ?? 200, out.contentType ?? "application/octet-stream", out.bytes);
          else send(res, out.status ?? 200, "application/json", JSON.stringify({ data: out.json ?? null }));
        } catch (e) {
          if (e instanceof DomainError) {
            if (e.httpStatus >= 500) log(`${method} ${url.pathname} failed: ${e.code} ${e.message} ${JSON.stringify((e as { details?: unknown }).details ?? null)}`);
            send(res, e.httpStatus, "application/json", JSON.stringify({ error: { code: e.code, message: e.message } })); return; }
          log(`unexpected error on ${method} ${url.pathname}: ${e instanceof Error ? e.message : String(e)}`);
          send(res, 500, "application/json", JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Something went wrong in the app" } }));
        }
      })();
    });
  });
}
