// Applies committed migrations to the dedicated TEST database only.
// Refuses to run unless the target database name ends with "_test".
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.TEST_DATABASE_URL ?? "postgresql://medos@127.0.0.1:54329/medos_test";
const dbName = new URL(url).pathname.replace("/", "");
if (!dbName.endsWith("_test")) {
  console.error(`Refusing to run tests against database "${dbName}" (must end with _test)`);
  process.exit(1);
}
const dbPkg = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/database");
const r = spawnSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
  cwd: dbPkg,
  env: { ...process.env, DATABASE_URL: url},
  shell: true,
  stdio: "inherit",
});
process.exit(r.status ?? 1);
