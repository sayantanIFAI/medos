// Creates (or refreshes) the voice bot's own MedOS login and writes the bridge's settings to .local/voice-bridge.env.
//
//   MEDOS_ADMIN_PASSWORD=... node scripts/voice-bot-provision.mjs [--tenant demo-hospital] [--api http://localhost:4000/api/v1]
//                          [--ssh-host <pod ip>] [--ssh-port <pod ssh port>] [--ssh-key ~/.ssh/id_ed25519]
//
// The bot's user holds ONE purpose-built role ("Voice bot (BAANI)"): record bookings the voice bot has already confirmed, plus the
// patient rights needed to register a new caller. It can read nothing else. The generated password is written to the env file
// (.local is git-ignored) and is never printed. Running this again rotates the password.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const API = arg("api", process.env.MEDOS_API_URL ?? "http://localhost:4000/api/v1");
const TENANT = arg("tenant", process.env.MEDOS_TENANT ?? "demo-hospital");
const ADMIN = arg("admin", process.env.MEDOS_ADMIN_USER ?? "admin");
const ADMIN_PW = process.env.MEDOS_ADMIN_PASSWORD;
if (!ADMIN_PW) { console.error("Set MEDOS_ADMIN_PASSWORD (the administrator's password for this hospital)."); process.exit(1); }

const ROLE = "Voice bot (BAANI)";
const PERMISSIONS = ["VOICE_BOOKING_SYNC", "PATIENT_READ", "PATIENT_CREATE", "DUPLICATE_OVERRIDE", "APPOINTMENT_READ"];
const USERNAME = "baani";

async function call(method, path, token, body) {
  const r = await fetch(`${API}${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
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

const facilities = await call("GET", "/facilities", token);
const facilityIds = facilities.map((f) => f.id);
if (!facilityIds.length) throw new Error("No facility found for this hospital.");

// a strong random password that satisfies the policy (upper, lower, digit, symbol); never shown
const password = `Bb1-${randomBytes(18).toString("base64url")}`;
const users = await call("GET", "/users?pageSize=100", token);
const list = Array.isArray(users) ? users : users.data ?? [];
const existing = list.find((u) => u.username === USERNAME);
if (existing) {
  await call("PUT", `/users/${existing.id}/roles`, token, { roleIds: [role.id] });
  await call("POST", `/users/${existing.id}/reset-password`, token, { password });
} else {
  await call("POST", "/users", token, { username: USERNAME, fullName: "Voice bot (BAANI)", password, roleIds: [role.id], facilityIds });
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, ".local", "voice-bridge.env");
mkdirSync(dirname(file), { recursive: true });
const keyPath = arg("ssh-key", process.env.VOICEBOT_SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519"));
const lines = [
  "# Written by scripts/voice-bot-provision.mjs. Contains a password: keep it private (this folder is git-ignored).",
  `MEDOS_API_URL=${API}`, `MEDOS_TENANT=${TENANT}`, `MEDOS_BOT_USER=${USERNAME}`, `MEDOS_BOT_PASSWORD=${password}`,
  `VOICEBOT_SSH_HOST=${arg("ssh-host", process.env.VOICEBOT_SSH_HOST ?? "")}`, `VOICEBOT_SSH_PORT=${arg("ssh-port", process.env.VOICEBOT_SSH_PORT ?? "22")}`, `VOICEBOT_SSH_KEY=${keyPath}`,
  "",
];
writeFileSync(file, lines.join("\n"), { mode: 0o600 });
console.log(`Voice bot user "${USERNAME}" ready with role "${ROLE}". Settings written to ${file}`);
