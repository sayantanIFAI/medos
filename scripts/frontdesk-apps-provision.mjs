// Creates (or refreshes) the MedOS logins of the two front-desk apps and writes each app's settings file under .local/.
//
//   MEDOS_ADMIN_PASSWORD=... node scripts/frontdesk-apps-provision.mjs [--tenant demo-hospital] [--api http://127.0.0.1:4000/api/v1]
//
// Each app is its own MedOS user ("voicebot-app", "ocr-app") holding ONE purpose-built role, "Front-desk apps": look up lab rates and doctors,
// book lab tests and appointments, register a new caller and keep a scanned prescription with its patient. It can read nothing else (no bills,
// notes, prescriptions or audit trail) and MedOS audits everything it does under its own name. The generated passwords go into the env files
// (.local is git-ignored) and are never printed. Running this again rotates them.
//
// The AI pod's address and token are copied from .local/ai-remote.env (written when the pod was set up) so the apps can reach it.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const API = arg("api", process.env.MEDOS_API_URL ?? "http://127.0.0.1:4000/api/v1");
const TENANT = arg("tenant", process.env.MEDOS_TENANT ?? "demo-hospital");
const WEB = arg("web", process.env.MEDOS_WEB_URL ?? "http://localhost:3000");
const ADMIN = arg("admin", process.env.MEDOS_ADMIN_USER ?? "admin");
const ADMIN_PW = process.env.MEDOS_ADMIN_PASSWORD;
if (!ADMIN_PW) { console.error("Set MEDOS_ADMIN_PASSWORD (the administrator's password for this hospital)."); process.exit(1); }

const ROLE = "Front-desk apps";
// DUPLICATE_OVERRIDE: a second family member on the same mobile number is registered as a new patient and flagged for reception to review, never merged
const PERMISSIONS = ["ASSISTANT_USE", "LAB_READ", "LAB_BOOK", "APPOINTMENT_READ", "APPOINTMENT_CREATE", "PATIENT_READ", "PATIENT_CREATE", "PATIENT_UPDATE", "DUPLICATE_OVERRIDE"];
const APPS = [
  { user: "voicebot-app", fullName: "Voicebot app", file: "voicebot.env", port: ["VOICEBOT_PORT", 5101] },
  { user: "ocr-app", fullName: "OCR app", file: "ocr-app.env", port: ["OCR_APP_PORT", 5102] },
];

async function call(method, path, token, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? ""}`.trim());
  return json.data ?? json;
}

const login = await call("POST", "/auth/login", null, { tenantCode: TENANT, identifier: ADMIN, password: ADMIN_PW });
const token = login.tokens?.accessToken;
if (!token) throw new Error("Login did not return a token (is a second step such as a facility choice required?).");

const roles = await call("GET", "/roles", token);
let role = roles.find((r) => r.name === ROLE);
if (!role) role = await call("POST", "/roles", token, { name: ROLE, permissions: PERMISSIONS });
else await call("PUT", `/roles/${role.id}/permissions`, token, { permissions: PERMISSIONS });

const facilityIds = (await call("GET", "/facilities", token)).map((f) => f.id);
if (!facilityIds.length) throw new Error("No facility found for this hospital.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aiEnvFile = join(root, ".local", "ai-remote.env");
const ai = {};
if (existsSync(aiEnvFile)) for (const line of readFileSync(aiEnvFile, "utf8").split(/\r?\n/)) { const m = /^\s*([A-Z_]+)\s*=\s*(\S+)\s*$/.exec(line); if (m) ai[m[1]] = m[2]; }

const users = await call("GET", "/users?pageSize=100", token);
const list = Array.isArray(users) ? users : users.data ?? [];
mkdirSync(join(root, ".local"), { recursive: true });

for (const app of APPS) {
  // a strong random password that satisfies the policy (upper, lower, digit, symbol); never shown
  const password = `Fd1-${randomBytes(18).toString("base64url")}`;
  const existing = list.find((u) => u.username === app.user);
  if (existing) {
    await call("PUT", `/users/${existing.id}/roles`, token, { roleIds: [role.id] });
    await call("POST", `/users/${existing.id}/reset-password`, token, { password });
  } else {
    await call("POST", "/users", token, { username: app.user, fullName: app.fullName, password, roleIds: [role.id], facilityIds });
  }
  const lines = [
    `# Written by scripts/frontdesk-apps-provision.mjs. Contains a password: keep it private (this folder is git-ignored).`,
    `MEDOS_URL=${API}`, `MEDOS_WEB_URL=${WEB}`, `MEDOS_TENANT=${TENANT}`, `MEDOS_USER=${app.user}`, `MEDOS_PASSWORD=${password}`,
    `AI_URL=${ai.AI_REMOTE_URL ?? "http://127.0.0.1:8765"}`, `AI_TOKEN=${ai.AI_REMOTE_TOKEN ?? ""}`, ...(app.user === "voicebot-app" ? [`LLM_MODEL=${ai.ASSISTANT_LLM_MODEL ?? "qwen2.5:14b"}`] : []),
    `${app.port[0]}=${app.port[1]}`, "",
  ];
  writeFileSync(join(root, ".local", app.file), lines.join("\n"), { mode: 0o600 });
  console.log(`${app.fullName}: user "${app.user}" ready with role "${ROLE}". Settings written to .local/${app.file}`);
}
