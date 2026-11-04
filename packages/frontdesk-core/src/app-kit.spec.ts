import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DomainError } from "@medos/shared";
import { createAppServer, loadEnvFile } from "./app-kit";

describe("app kit (the local server both apps use)", () => {
  let server: http.Server;
  let port: number;
  let dir: string;

  const call = (opts: { method?: string; path?: string; headers?: Record<string, string>; body?: Buffer | string }) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/", headers: opts.headers }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.end(opts.body);
  });

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-kit-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>page</h1>");
    fs.writeFileSync(path.join(path.dirname(dir), "secret-outside.txt"), "secret");
    server = createAppServer({
      staticDir: dir, maxBodyBytes: 100,
      routes: {
        "GET /api/ok": async () => ({ json: { fine: true } }),
        "POST /api/echo": async (req) => ({ json: { size: req.body.length } }),
        "POST /api/refuse": async () => { throw new DomainError("VALIDATION_FAILED", "Not that", 400); },
        "POST /api/crash": async () => { throw new Error("boom with details"); },
      },
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => { await new Promise((ok) => server.close(ok)); });

  it("serves the page and the routes, and nothing outside the page folder", async () => {
    assert.match((await call({})).body, /page/);
    assert.deepEqual(JSON.parse((await call({ path: "/api/ok" })).body), { data: { fine: true } });
    assert.equal((await call({ path: "/../secret-outside.txt" })).status, 404);
    assert.equal((await call({ path: "/%2e%2e/secret-outside.txt" })).status, 404);
    assert.equal((await call({ path: "/nothing.html" })).status, 404);
  });

  it("answers only on this computer: another Host name is refused", async () => {
    assert.equal((await call({ headers: { host: "evil.example.com" } })).status, 403);
    assert.equal((await call({ headers: { host: `localhost:${port}` } })).status, 200);
  });

  it("refuses a POST that does not carry the app's own header, so another website cannot drive it", async () => {
    assert.equal((await call({ method: "POST", path: "/api/echo", body: "x" })).status, 403);
    assert.equal((await call({ method: "POST", path: "/api/echo", body: "xy", headers: { "x-medos-app": "1" } })).body, JSON.stringify({ data: { size: 2 } }));
  });

  it("turns known errors into plain answers, hides unknown ones, and limits upload size", async () => {
    const h = { "x-medos-app": "1" };
    const refused = await call({ method: "POST", path: "/api/refuse", headers: h });
    assert.equal(refused.status, 400);
    assert.equal(JSON.parse(refused.body).error.code, "VALIDATION_FAILED");
    const crashed = await call({ method: "POST", path: "/api/crash", headers: h });
    assert.equal(crashed.status, 500);
    assert.ok(!crashed.body.includes("boom"), "internal details are not shown");
    assert.equal((await call({ method: "POST", path: "/api/echo", headers: h, body: Buffer.alloc(101) })).status, 413);
  });

  it("reads settings from an env file without overriding what is already set", () => {
    const f = path.join(dir, "x.env");
    fs.writeFileSync(f, "# comment\nKIT_A=one\nKIT_B=\"two words\"\nKIT_C=three\n");
    process.env["KIT_C"] = "already";
    loadEnvFile(f);
    assert.equal(process.env["KIT_A"], "one");
    assert.equal(process.env["KIT_B"], "two words");
    assert.equal(process.env["KIT_C"], "already");
    loadEnvFile(path.join(dir, "missing.env"));
  });
});
