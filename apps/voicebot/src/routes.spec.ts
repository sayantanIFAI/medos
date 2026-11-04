import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { emptyNlu, FrontDeskEngine, PodClient, type FrontDeskPort, type LlmClient } from "@medos/frontdesk-core";
import { buildRoutes } from "./routes";

const TOKEN = "pod-token-0123456789";
const seen: { url: string; auth: string | undefined; type: string | undefined }[] = [];

const model: LlmClient = { completeJson: async () => JSON.stringify({ ...emptyNlu(), intent: "LAB_RATE", language: "hi", tests: ["सीबीसी"] }) };
const port = {
  can: () => true, timezone: async () => "Asia/Kolkata",
  findTests: async () => [{ testId: "t1", name: "Complete Blood Count (CBC)", matched: "cbc", confidence: "HIGH" as const, reason: "name" as const, price: "400.00" }],
  labTests: async () => [{ id: "t1", name: "Complete Blood Count (CBC)", price: "400.00", reportHours: 6, fastingRequired: false, prepEn: null, prepHi: null }],
} as unknown as FrontDeskPort;

describe("voicebot app routes", () => {
  let pod: http.Server;
  let routes: ReturnType<typeof buildRoutes>;

  before(async () => {
    pod = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", auth: req.headers.authorization, type: req.headers["content-type"] });
        if (req.url?.startsWith("/asr")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: " CBC का रेट ", language: "hi", seconds: 1.2 })); }
        else if (req.url === "/tts") { res.setHeader("content-type", "audio/wav"); res.end(Buffer.from("RIFFwav")); }
        else { res.statusCode = 404; res.end("{}"); }
      });
    });
    await new Promise<void>((ok) => pod.listen(0, "127.0.0.1", ok));
    const podClient = new PodClient({ url: `http://127.0.0.1:${(pod.address() as AddressInfo).port}`, token: TOKEN, timeoutMs: 3000 });
    routes = buildRoutes({ engine: new FrontDeskEngine(model), pod: podClient, medos: async () => port, status: async () => ({ app: "voicebot" }) });
  });
  after(async () => { await new Promise((ok) => pod.close(ok)); });

  const req = (body: Buffer | string, query: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    ({ method: "POST", path: "/", query: new URLSearchParams(query), headers, body: Buffer.from(body) });
  const run = (key: string, r: ReturnType<typeof req>) => (routes[key] as NonNullable<(typeof routes)[string]>)(r);
  const isInvalid = (e: { code?: string }) => e.code === "VALIDATION_FAILED";

  it("answers a Hindi rate question from MedOS's rates", async () => {
    const out = (await run("POST /api/turn", req(JSON.stringify({ text: "सीबीसी का रेट बताओ", lang: "hi" })))).json as { reply: string; engine: string };
    assert.equal(out.engine, "model");
    assert.ok(out.reply.includes("₹400") && out.reply.includes("Complete Blood Count"), out.reply);
  });

  it("sends a voice clip to the pod with its token and the kind of answer expected, and returns the words", async () => {
    const out = (await run("POST /api/transcribe", req("clip-bytes", { lang: "hi", hint: "age" }, { "content-type": "audio/webm;codecs=opus" }))).json as { text: string };
    assert.equal(out.text, "CBC का रेट");
    const call = seen[seen.length - 1];
    assert.equal(call?.auth, `Bearer ${TOKEN}`);
    assert.match(call?.url ?? "", /prompt=/);
    assert.match(call?.type ?? "", /^audio\/webm/);
  });

  it("has the pod speak a reply and returns the audio", async () => {
    const out = await run("POST /api/speak", req(JSON.stringify({ text: "नमस्ते", lang: "hi" })));
    assert.equal(out.contentType, "audio/wav");
    assert.equal(out.bytes?.toString(), "RIFFwav");
  });

  it("rejects what it does not understand with a plain 400", async () => {
    await assert.rejects(run("POST /api/turn", req(JSON.stringify({ text: "", lang: "hi" }))), isInvalid);
    await assert.rejects(run("POST /api/turn", req(JSON.stringify({ text: "hi", extra: 1 }))), isInvalid);
    await assert.rejects(run("POST /api/transcribe", req("x", { hint: "password" }, { "content-type": "audio/wav" })), isInvalid);
    await assert.rejects(run("POST /api/transcribe", req("x", { lang: "hi" }, { "content-type": "text/plain" })), isInvalid);
  });
});
