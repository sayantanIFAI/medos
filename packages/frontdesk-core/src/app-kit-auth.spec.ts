import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createAppServer } from "./app-kit";

describe("app kit behind a tunnel: login gate and allowed host names", () => {
  let server: http.Server;
  let port: number;

  const call = (headers: Record<string, string>, method = "GET", p = "/") => new Promise<{ status: number; www: string | undefined }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0, www: res.headers["www-authenticate"] })); });
    req.on("error", reject); req.end();
  });
  const basic = (u: string, p: string) => ({ authorization: `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}` });

  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-kit-auth-"));
    fs.writeFileSync(path.join(dir, "index.html"), "page");
    server = createAppServer({ staticDir: dir, allowedHostSuffixes: [".trycloudflare.com"], basicAuth: "demo:correct horse", routes: { "POST /api/x": async () => ({ json: 1 }) } });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => { await new Promise((ok) => server.close(ok)); });

  it("asks everyone, the page and the routes alike, to sign in", async () => {
    const page = await call({ host: "abc-def.trycloudflare.com" });
    assert.equal(page.status, 401);
    assert.match(page.www ?? "", /^Basic/);
    assert.equal((await call({ host: "abc-def.trycloudflare.com", "x-medos-app": "1" }, "POST", "/api/x")).status, 401);
    assert.equal((await call({ host: "abc-def.trycloudflare.com", ...basic("demo", "wrong") })).status, 401);
    assert.equal((await call({ host: "abc-def.trycloudflare.com", ...basic("demo", "correct hors") })).status, 401, "a shorter password is not accepted");
    assert.equal((await call({ host: "abc-def.trycloudflare.com", ...basic("demo", "correct horse") })).status, 200);
    assert.equal((await call({ host: "abc-def.trycloudflare.com", "x-medos-app": "1", ...basic("demo", "correct horse") }, "POST", "/api/x")).status, 200);
  });

  it("answers on the tunnel's host name but on no other outside name", async () => {
    assert.equal((await call({ host: "evil.example.com", ...basic("demo", "correct horse") })).status, 403);
    assert.equal((await call({ host: "trycloudflare.com.evil.example.com", ...basic("demo", "correct horse") })).status, 403);
    assert.equal((await call({ host: "localhost", ...basic("demo", "correct horse") })).status, 200);
  });
});
