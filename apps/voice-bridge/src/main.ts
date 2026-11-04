import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Bridge } from "./bridge";
import { MedosClient } from "./clients";
import { PodReader, type PodAccess } from "./pod";
import { StateStore } from "./state";
import { TransientError, type RosterDoctor } from "./types";

/** Reads a plain KEY=VALUE file (the provisioning script writes .local/voice-bridge.env). Existing environment variables win. */
function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1] as string] === undefined) process.env[m[1] as string] = (m[2] as string).replace(/^["']|["']$/g, "");
  }
}

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k}. Run scripts/voice-bot-provision.mjs, or set it in the environment.`);
  return v;
};
const num = (k: string, d: number): number => (process.env[k] ? Number(process.env[k]) : d);
const stamp = (l: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${l}`);

const USAGE = `voice bridge: records the voice bot's bookings in MedOS (read-only on the pod)
  node dist/main.js doctors     load the demo roster of doctors into MedOS (once)
  node dist/main.js once        catch up with new bookings, report anything needing attention, exit
  node dist/main.js [start]     keep running: check for new bookings every 5 seconds
  node dist/main.js replay      forget the read position and read the whole log again (safe: nothing is booked twice)`;

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "..", "..", "..");
  loadEnvFile(path.join(root, ".local", "voice-bridge.env"));
  const mode = process.argv[2] ?? "start";
  if (!["doctors", "once", "start", "replay"].includes(mode)) { console.log(USAGE); return; }

  const medos = new MedosClient({ baseUrl: need("MEDOS_API_URL"), tenantCode: need("MEDOS_TENANT"), identifier: need("MEDOS_BOT_USER"), password: need("MEDOS_BOT_PASSWORD") });
  const store = new StateStore(process.env.BRIDGE_STATE ?? path.join(root, ".local", "voice-bridge-state.json"));
  const pod: PodAccess = {
    host: need("VOICEBOT_SSH_HOST"), port: num("VOICEBOT_SSH_PORT", 22), user: process.env.VOICEBOT_SSH_USER ?? "root",
    keyPath: process.env.VOICEBOT_SSH_KEY ?? path.join(os.homedir(), ".ssh", "id_ed25519"),
  };
  const bridge = new Bridge(new PodReader(pod, num("VOICEBOT_SLOT_MINUTES", 10)), medos, store, { log: stamp });

  if (mode === "doctors") {
    const file = path.resolve(__dirname, "..", "data", "kcd-doctors.json");
    const roster = (JSON.parse(fs.readFileSync(file, "utf8")) as { doctors: RosterDoctor[] }).doctors;
    await bridge.syncDoctors(roster);
    return;
  }
  if (mode === "replay") { store.state.logOffset = 0; store.save(); stamp("read position reset; the next run reads the whole log again"); return; }

  const guarded = async (name: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) {
      if (e instanceof TransientError) stamp(`${name}: will retry (${e.message})`);
      else { stamp(`${name} failed: ${e instanceof Error ? e.message : String(e)}`); if (mode === "once") throw e; }
    }
  };

  if (mode === "once") {
    await guarded("pull", () => bridge.pullNew());
    await guarded("reconcile", () => bridge.reconcile(0));
    const failed = Object.entries(store.state.failed);
    stamp(`done. read ${store.state.logOffset} bytes of the log, watching ${Object.keys(store.state.tracked).length}, needing attention ${failed.length}`);
    for (const [ref, f] of failed) stamp(`  ${ref}: ${f.code}`);
    return;
  }

  stamp("voice bridge running (read-only on the pod). Ctrl+C to stop.");
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  for (;;) {
    await guarded("tick", () => bridge.tick());
    await new Promise((r) => setTimeout(r, num("BRIDGE_POLL_MS", 5000)));
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
