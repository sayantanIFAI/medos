// Loads the demo lab-test catalogue (34 tests with rates and Hindi/English names) into a MedOS hospital. Safe to run again: tests are matched by code.
//   MEDOS_ADMIN_PASSWORD=... node scripts/import-lab-catalogue.mjs [--tenant demo-hospital] [--api http://localhost:4000/api/v1]
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const API = arg("api", process.env.MEDOS_API_URL ?? "http://localhost:4000/api/v1");
const TENANT = arg("tenant", process.env.MEDOS_TENANT ?? "demo-hospital");
const ADMIN = arg("admin", process.env.MEDOS_ADMIN_USER ?? "admin");
const PW = process.env.MEDOS_ADMIN_PASSWORD;
if (!PW) { console.error("Set MEDOS_ADMIN_PASSWORD (the administrator's password for this hospital)."); process.exit(1); }

const call = async (method, path, token, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${j?.error?.code ?? ""} ${JSON.stringify(j?.error?.details ?? "")}`);
  return j.data ?? j;
};

const here = dirname(fileURLToPath(import.meta.url));
const { tests } = JSON.parse(readFileSync(join(here, "data", "kcd-lab-tests.json"), "utf8"));
const login = await call("POST", "/auth/login", null, { tenantCode: TENANT, identifier: ADMIN, password: PW });
const token = login.tokens.accessToken;
let created = 0, updated = 0;
// a bundle ("includes": test names) books exactly those tests; bundles come after the tests they include in the data file
const codeOf = new Map(tests.map((t, i) => [t.name, `LAB-${String(i + 1).padStart(3, "0")}`]));
for (const [i, t] of tests.entries()) {
  const r = await call("PUT", "/lab/tests", token, {
    code: `LAB-${String(i + 1).padStart(3, "0")}`, name: t.name, price: t.rateInr, sampleType: t.sample || "Blood", reportHours: Math.max(1, t.reportHours || 24),
    fastingRequired: !!t.fasting, ...(t.prepEn ? { prepEn: t.prepEn.slice(0, 400) } : {}), ...(t.prepHi ? { prepHi: t.prepHi.slice(0, 400) } : {}),
    aliases: t.aliases.filter((a) => a.length <= 60).slice(0, 60),
    ...(t.includes?.length ? { includes: t.includes.map((n) => { const c = codeOf.get(n); if (!c) throw new Error(`Bundle "${t.name}" includes "${n}", which is not in the catalogue`); return c; }) } : {}),
  });
  r.created ? created++ : updated++;
}
console.log(`Lab catalogue loaded: ${created} new, ${updated} updated (${tests.length} tests).`);
