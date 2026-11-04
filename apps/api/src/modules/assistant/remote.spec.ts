import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../../common/config";
import { makeUserWithPermissions, startApp, type TestApp, type TestTenant } from "../../test/harness";
import { AsrService } from "./asr.service";
import { OllamaClient } from "@medos/frontdesk-core";
import { OcrService } from "./ocr.service";

const TOKEN = "test-token-0123456789";
const CFG = (url: string | undefined) => ({ AI_REMOTE_URL: url, AI_REMOTE_TOKEN: TOKEN, AI_REMOTE_TIMEOUT_MS: 3000 }) as AppConfig;

interface Seen { method: string | undefined; url: string | undefined; auth: string | undefined; type: string | undefined; bytes: number; body: string }

describe("remote AI host (speech, reading, language model)", () => {
  let host: http.Server;
  let base: string;
  let t: TestApp;
  let a: TestTenant;
  let rec: { id: string; token: string };
  const seen: Seen[] = [];
  let ocrConfidence = 90;

  before(async () => {
    // a stand-in for the Kaggle host: nothing is recognised or generated here, it only answers in the host's format
    host = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], bytes: body.length, body: body.toString("utf8") });
        res.setHeader("content-type", "application/json");
        if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.end("{}"); return; }
        if (req.url?.startsWith("/asr")) res.end(JSON.stringify({ text: "  CBC की   कीमत कितनी है  ", language: "hi", seconds: 2.4 }));
        else if (req.url?.startsWith("/ocr")) res.end(JSON.stringify({ text: "Lipid Profile", confidence: ocrConfidence, engine: "easyocr" }));
        else if (req.url === "/api/chat") res.end(JSON.stringify({ message: { content: "{\"intent\":\"OTHER\"}" } }));
        else if (req.url === "/tts") { res.setHeader("content-type", "audio/wav"); res.end(Buffer.from("RIFFfakewav")); }
        else { res.statusCode = 404; res.end("{}"); }
      });
    });
    await new Promise<void>((ok) => host.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
    process.env["AI_REMOTE_URL"] = base;
    process.env["AI_REMOTE_TOKEN"] = TOKEN;
    t = await startApp();
    a = await t.makeTenant("remote-a");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
  });
  after(async () => {
    delete process.env["AI_REMOTE_URL"];
    delete process.env["AI_REMOTE_TOKEN"];
    await t.close();
    await new Promise((ok) => host.close(ok));
  });

  it("tells the screen what is connected, without revealing the address or token", async () => {
    const r = await t.api("get", "/assistant/capabilities", rec.token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, { voice: true, speaking: true, prescriptionReading: true, model: true });
    assert.ok(!JSON.stringify(r.body).includes(base) && !JSON.stringify(r.body).includes(TOKEN));
  });

  it("sends a voice clip to the host and returns only the words, tidied", async () => {
    const clip = Buffer.from("not-really-audio-but-bytes");
    const r = await t.api("post", "/assistant/transcribe?lang=hi", rec.token).set("Content-Type", "audio/webm;codecs=opus").send(clip);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.text, "CBC की कीमत कितनी है");
    assert.equal(r.body.data.language, "hi");
    const call = seen[seen.length - 1];
    assert.equal(call?.method, "POST");
    assert.equal(call?.auth, `Bearer ${TOKEN}`, "the host's token is sent");
    assert.match(call?.url ?? "", /^\/asr\?language=hi$/);
    assert.match(call?.type ?? "", /^audio\/webm/);
    assert.equal(call?.bytes, clip.length, "the clip is passed through unchanged");
    assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: { contains: "TRANSCRIB" } } }), 0, "the words spoken are not recorded");
  });

  it("tells the speech model what kind of answer to expect, so short answers are heard correctly", async () => {
    const clip = Buffer.from("bytes");
    const r = await t.api("post", "/assistant/transcribe?lang=hi&hint=age", rec.token).set("Content-Type", "audio/webm").send(clip);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const url = new URL(`http://x${seen[seen.length - 1]?.url ?? ""}`);
    assert.equal(url.searchParams.get("language"), "hi");
    assert.match(url.searchParams.get("prompt") ?? "", /उम्र/, "an age hint tells the model an age is coming");
    const bad = await t.api("post", "/assistant/transcribe?lang=hi&hint=password", rec.token).set("Content-Type", "audio/webm").send(clip);
    assert.equal(bad.status, 400, "only known hints are accepted");
  });

  it("has the host speak a reply and hands back the audio, nothing stored", async () => {
    const r = await t.api("post", "/assistant/speak", rec.token).send({ text: "आपकी बुकिंग हो गई है", lang: "hi" }).buffer(true).responseType("blob");
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-type"]), /^audio\/wav/);
    assert.equal(Buffer.from(r.body as Buffer).toString("utf8"), "RIFFfakewav");
    const call = seen[seen.length - 1];
    assert.equal(call?.url, "/tts");
    assert.equal(call?.auth, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(call?.body ?? "{}"), { text: "आपकी बुकिंग हो गई है", language: "hi" });
    const noUse = await makeUserWithPermissions(t, a, ["PATIENT_READ"]);
    assert.equal((await t.api("post", "/assistant/speak", noUse.token).send({ text: "hello" })).status, 403);
    assert.equal((await t.api("post", "/assistant/speak", rec.token).send({ text: "" })).status, 400);
    assert.equal((await t.api("post", "/assistant/speak", rec.token).send({ text: "hi", lang: "bn" })).status, 400);
  });

  it("checks who may speak to it and what they send", async () => {
    const send = (token: string | null, q: string, type: string, body: Buffer | string) => {
      const req = t.api("post", `/assistant/transcribe${q}`, token ?? undefined);
      return req.set("Content-Type", type).send(body);
    };
    const clip = Buffer.from("bytes");
    const noUse = await makeUserWithPermissions(t, a, ["PATIENT_READ"]);
    assert.equal((await send(noUse.token, "", "audio/wav", clip)).status, 403, "needs ASSISTANT_USE");
    assert.equal((await send(null, "", "audio/wav", clip)).status, 401);
    assert.equal((await send(rec.token, "", "text/plain", "hello")).status, 400, "only audio is accepted");
    assert.equal((await send(rec.token, "?lang=bn", "audio/wav", clip)).status, 400, "only Hindi or English");
    assert.equal((await send(rec.token, "?lang=hi&x=1", "audio/wav", clip)).status, 400, "no unknown options");
    assert.equal((await send(rec.token, "", "audio/wav", Buffer.alloc(6.5 * 1024 * 1024))).status, 413);
  });

  it("says plainly when the host cannot be reached, is not connected, or answers with rubbish", async () => {
    const down = new AsrService(CFG("http://127.0.0.1:1"));
    await assert.rejects(down.transcribe(Buffer.from("x"), "audio/wav", "hi"), (e: { code?: string; httpStatus?: number }) => e.code === "AI_SERVICE_UNAVAILABLE" && e.httpStatus === 503);

    const none = new AsrService({ AI_REMOTE_TIMEOUT_MS: 3000 } as AppConfig);
    assert.equal(none.available, false);
    await assert.rejects(none.transcribe(Buffer.from("x"), "audio/wav", "hi"), (e: { code?: string }) => e.code === "AI_SERVICE_UNAVAILABLE");
    await assert.rejects(new OcrService({ AI_REMOTE_TIMEOUT_MS: 3000 } as AppConfig).readImage(Buffer.from("x")), (e: { code?: string }) => e.code === "AI_SERVICE_UNAVAILABLE");

    const wrongToken = new OcrService({ ...CFG(base), AI_REMOTE_TOKEN: "some-other-token-0000" } as AppConfig);
    await assert.rejects(wrongToken.readImage(Buffer.from("x")), (e: { code?: string }) => e.code === "AI_SERVICE_UNAVAILABLE", "a host that refuses the token is treated as unavailable");

    const rubbish = http.createServer((_q, res) => { res.setHeader("content-type", "application/json"); res.end("{\"unexpected\":true}"); });
    await new Promise<void>((ok) => rubbish.listen(0, "127.0.0.1", ok));
    try {
      const odd = new OcrService(CFG(`http://127.0.0.1:${(rubbish.address() as AddressInfo).port}`));
      await assert.rejects(odd.readImage(Buffer.from("x")), (e: { code?: string }) => e.code === "AI_SERVICE_UNAVAILABLE");
    } finally { await new Promise((ok) => rubbish.close(ok)); }
  });

  it("reads a picture or PDF on the host and keeps the reading confidence between 0 and 100", async () => {
    const ocr = new OcrService(CFG(base));
    const img = await ocr.readImage(Buffer.from("png-bytes"), "image/jpeg");
    assert.deepEqual(img, { text: "Lipid Profile", confidence: 90, engine: "remote-easyocr" });
    assert.equal(seen[seen.length - 1]?.type, "image/jpeg");
    await ocr.readPdf(Buffer.from("%PDF-"));
    assert.equal(seen[seen.length - 1]?.type, "application/pdf");
    ocrConfidence = 250;
    assert.equal((await ocr.readImage(Buffer.from("x"))).confidence, 100);
    ocrConfidence = -5;
    assert.equal((await ocr.readImage(Buffer.from("x"))).confidence, 0);
    ocrConfidence = 90;
  });

  it("asks the language model on the host with the host's token", async () => {
    const llm = new OllamaClient(base, "qwen2.5:7b", 3000, TOKEN);
    const out = await llm.completeJson("system words", "user words", { type: "object" });
    assert.equal(out, "{\"intent\":\"OTHER\"}");
    const call = seen[seen.length - 1];
    assert.equal(call?.url, "/api/chat");
    assert.equal(call?.auth, `Bearer ${TOKEN}`);
    const sent = JSON.parse(call?.body ?? "{}") as { model: string; stream: boolean; format: unknown; messages: { role: string }[] };
    assert.equal(sent.model, "qwen2.5:7b");
    assert.equal(sent.stream, false);
    assert.deepEqual(sent.format, { type: "object" }, "the answer is forced into a fixed shape");
    assert.deepEqual(sent.messages.map((m) => m.role), ["system", "user"]);
  });
});
