import { createAppServer, loadEnvFile, MedosClient, PodClient, requiredEnv } from "@medos/frontdesk-core";
import * as path from "node:path";
import { buildRoutes } from "./routes";

// Settings live in <repo>/.local/ocr-app.env (not committed). Anything already in the environment wins.
const repo = path.resolve(__dirname, "..", "..", "..");
loadEnvFile(process.env["OCR_APP_ENV"] ?? path.join(repo, ".local", "ocr-app.env"));

const port = Number(process.env["OCR_APP_PORT"] ?? 5102);
const medosCfg = {
  baseUrl: process.env["MEDOS_URL"] ?? "http://127.0.0.1:4000/api/v1", tenantCode: requiredEnv("MEDOS_TENANT"),
  identifier: requiredEnv("MEDOS_USER"), password: requiredEnv("MEDOS_PASSWORD"),
};
const medosWeb = process.env["MEDOS_WEB_URL"] ?? "http://localhost:3000";
const aiUrl = process.env["AI_URL"];
const aiToken = process.env["AI_TOKEN"];

const pod = new PodClient({ url: aiUrl, token: aiToken, timeoutMs: Number(process.env["AI_TIMEOUT_MS"] ?? 60_000) });

let client: MedosClient | null = null;
let lastMedosError: string | null = null;
/** Connects to MedOS the first time it is needed and keeps the connection; a failure is retried on the next call. */
async function medos(): Promise<MedosClient> {
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
  log: (m) => console.error(`[ocr-app] ${m}`),
  routes: buildRoutes({
    ocr: pod, medos,
    status: async () => {
      let medosOk = false;
      try { await medos(); medosOk = true; } catch { /* reported below */ }
      return { app: "ocr-app", medos: { connected: medosOk, user: client?.user ?? null, error: medosOk ? null : lastMedosError, webUrl: medosWeb }, pod: { configured: pod.configured, reachable: await podReachable() }};
    },
  }),
});
server.listen(port, "127.0.0.1", () => console.log(`OCR app: http://localhost:${port}  (AI pod: ${aiUrl ?? "not set"}, MedOS: ${medosCfg.baseUrl})`));
