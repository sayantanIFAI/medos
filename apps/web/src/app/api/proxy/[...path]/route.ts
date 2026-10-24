import type { NextRequest } from "next/server";
import { authedFetch } from "@/lib/server";

/**
 * Same-origin gateway to the API. Tokens live in httpOnly cookies and are attached here, so page JavaScript never sees them.
 * - Mutations need the x-medos-csrf header (browsers cannot add it cross-site without a preflight, which is not allowed).
 * - The auth endpoints are not reachable through the proxy, so a token can never be returned to the page.
 */
const SAFE = new Set(["GET", "HEAD"]);
const SEGMENT = /^[A-Za-z0-9_.~-]{1,100}$/;
const PASS_HEADERS = ["content-type", "idempotency-key", "accept"];

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  if (path.length === 0 || path.some((s) => !SEGMENT.test(s) || s === "." || s === "..") || path[0] === "auth") {
    return Response.json({ error: { code: "NOT_FOUND", message: "Resource not found" } }, { status: 404 });
  }
  if (!SAFE.has(req.method) && req.headers.get("x-medos-csrf") !== "1") {
    return Response.json({ error: { code: "FORBIDDEN", message: "Missing request header" } }, { status: 403 });
  }
  const headers: Record<string, string> = {};
  for (const h of PASS_HEADERS) { const v = req.headers.get(h); if (v) headers[h] = v; }
  const body = SAFE.has(req.method) ? null : await req.arrayBuffer();
  const res = await authedFetch(`/${path.join("/")}${req.nextUrl.search}`, { method: req.method, body, headers });
  const out = new Headers({ "cache-control": "no-store" });
  for (const h of ["content-type", "idempotent-replayed", "content-security-policy"]) { const v = res.headers.get(h); if (v) out.set(h, v); }
  return new Response(res.status === 204 ? null : res.body, { status: res.status, headers: out });
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
