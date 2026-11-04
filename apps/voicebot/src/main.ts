import { createAppServer, FrontDeskEngine, loadEnvFile, MedosClient, OllamaClient, PodClient, requiredEnv, type FrontDeskPort } from "@medos/frontdesk-core";
import * as path from "node:path";
import { buildRoutes } from "./routes";

// Settings live in <repo>/.local/voicebot.env (not committed). Anything already in the environment wins.
const repo = path.resolve(__dirname, "..", "..", "..");
loadEnvFile(process.env["VOICEBOT_ENV"] ?? path.join(repo, ".local", "voicebot.env"));

const port = Number(process.env["VOICEBOT_PORT"] ?? 5101);
const medosCfg = {
  baseUrl: process.env["MEDOS_URL"] ?? "http://127.0.0.1:4000/api/v1", tenantCode: requiredEnv("MEDOS_TENANT"),
  identifier: requiredEnv("MEDOS_USER"), password: requiredEnv("MEDOS_PASSWORD"),
};
const medosWeb = process.env["MEDOS_WEB_URL"] ?? "http://localhost:3000";
const aiUrl = process.env["AI_URL"];
const aiToken = process.env["AI_TOKEN"];
const model = process.env["LLM_MODEL"] ?? "qwen2.5:14b";

const pod = new PodClient({ url: aiUrl, token: aiToken, timeoutMs: Number(process.env["AI_TIMEOUT_MS"] ?? 60_000) });
const engine = new FrontDeskEngine(aiUrl ? new OllamaClient(aiUrl, model, Number(process.env["AI_TIMEOUT_MS"] ?? 60_000), aiToken) : null, {
  warn: (m) => console.warn(`[voicebot] ${m}`), error: (m) => console.error(`[voicebot] ${m}`),
});

let client: MedosClient | null = null;
let lastMedosError: string | null = null;
/** Connects to MedOS the first time it is needed and keeps the connection; a failure is retried on the next call. */
async function medos(): Promise<FrontDeskPort> {
  try {
    client ??= await MedosClient.connect(medosCfg);
    lastMedosError = null;
    return client;
  } catch (e) {
    client = null;
    lastMedosError = e instanceof Error ? e.message : "unknown";
    throw e;
  }
}

async function podReachable(): Promise<boolean> {
  if (!aiUrl) return false;
  try { return (await fetch(`${aiUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}

const server = createAppServer({
  staticDir: path.resolve(__dirname, "..", "public"),
  log: (m) => console.error(`[voicebot] ${m}`),
  routes: buildRoutes({
    engine, pod, medos,
    status: async () => {
      let medosOk = false;
      try { await medos(); medosOk = true; } catch { /* reported below */ }
      return { app: "voicebot", medos: { connected: medosOk, user: client?.user ?? null, error: medosOk ? null : lastMedosError, webUrl: medosWeb }, pod: { configured: pod.configured, reachable: await podReachable() }, model: engine.modelConfigured, modelName: model };
    },
  }),
});
server.listen(port, "127.0.0.1", () => console.log(`Voicebot app: http://localhost:${port}  (AI pod: ${aiUrl ?? "not set"}, MedOS: ${medosCfg.baseUrl})`));
