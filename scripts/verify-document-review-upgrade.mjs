#!/usr/bin/env node
// Destructive acceptance only: explicitly named linked-worktree slot, never main or remote.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";

const BASELINE = "5e60cba61410dc80fc48f9c03a2de1f1342b30aa";
const BOUNDARY = "20261129090000";
const args = process.argv.slice(2);
const slot = Number(args[args.indexOf("--slot") + 1]);
assert(args.includes("--confirm-reset") && Number.isInteger(slot) && slot >= 1 && slot <= 99,
  "Usage: node scripts/verify-document-review-upgrade.mjs --slot N --confirm-reset (destroys only that owned local worktree DB)");
const root = fs.realpathSync(process.cwd());
const git = (...values) => execFileSync("git", values, { encoding: "utf8" }).trim();
assert.equal(root, fs.realpathSync(git("rev-parse", "--show-toplevel")));
assert.notEqual(fs.realpathSync(git("rev-parse", "--git-dir")), fs.realpathSync(git("rev-parse", "--git-common-dir")), "Refuse main checkout");
assert.match(fs.readFileSync(".env", "utf8"), new RegExp(`^SUPABASE_SLOT=${slot}$`, "m"));
const config = fs.readFileSync(".supabase-worktree/supabase/config.toml", "utf8");
assert.match(config, new RegExp(`^project_id = "ivat-wt${slot}"$`, "m"));
const status = JSON.parse(execFileSync(process.execPath, ["scripts/supabase.mjs", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
assert.equal(status.API_URL, `http://127.0.0.1:${54321 + 100 * slot}`);
const dbUrl = new URL(status.DB_URL);
assert.equal(dbUrl.hostname, "127.0.0.1");
assert.equal(Number(dbUrl.port), 54322 + 100 * slot);
assert.equal(dbUrl.pathname, "/postgres");
const container = JSON.parse(execFileSync("docker", ["inspect", `supabase_db_ivat-wt${slot}`], { encoding: "utf8" }))[0];
assert.equal(container.Name, `/supabase_db_ivat-wt${slot}`);
assert(container.NetworkSettings.Ports["5432/tcp"].some(binding => Number(binding.HostPort) === Number(dbUrl.port)));
assert(!fs.existsSync(".supabase-worktree/claim-clock-restore.json"), "Restore/reset interrupted clock fixture before acceptance");
const nextListeners = spawnSync("lsof", ["-t", "-a", "-iTCP:3142", "-sTCP:LISTEN"], { encoding: "utf8" });
assert.equal(nextListeners.status, 1, "Stop acceptance Next before resetting its DB");
const baselinePackage = JSON.parse(git("show", `${BASELINE}:package.json`));
const currentPackage = JSON.parse(fs.readFileSync("package.json", "utf8"));
for (const field of ["dependencies", "devDependencies", "optionalDependencies", "overrides", "engines"]) {
  assert.deepEqual(currentPackage[field], baselinePackage[field], `Baseline dependency compatibility drift: ${field}`);
}
for (const file of ["package-lock.json", "vitest.config.ts", "tests/support/global-setup.ts"]) {
  assert.equal(git("show", `${BASELINE}:${file}`), fs.readFileSync(file, "utf8").trim(), `Baseline dependency/setup drift: ${file}`);
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-242-upgrade-"));
fs.chmodSync(directory, 0o700);
const baseline = path.join(directory, "baseline");
fs.mkdirSync(baseline);
execFileSync("tar", ["-x", "-C", baseline], { input: execFileSync("git", ["archive", BASELINE], { maxBuffer: 64 * 1024 * 1024 }) });
fs.symlinkSync(path.join(root, "node_modules"), path.join(baseline, "node_modules"));
fs.mkdirSync(path.join(baseline, "tests/upgrade"));
for (const file of ["document-review-baseline.fixture.ts", "document-review-capture.ts"]) {
  fs.copyFileSync(path.join(root, "tests/upgrade", file), path.join(baseline, "tests/upgrade", file));
}
const manifest = path.join(directory, "manifest.json");
const context = path.join(directory, "context.json");
fs.writeFileSync(context, JSON.stringify({ supabaseUrl: status.API_URL, supabaseAnonKey: status.PUBLISHABLE_KEY,
  supabaseSecretKey: status.SECRET_KEY, supabaseJwtSecret: status.JWT_SECRET, databaseUrl: status.DB_URL }), { mode: 0o600 });
const setup = path.join(directory, "setup.mjs");
fs.writeFileSync(setup, `import fs from 'node:fs'; export default function setup(project) { const values=JSON.parse(fs.readFileSync(${JSON.stringify(context)},'utf8')); for(const [key,value] of Object.entries(values)) project.provide(key,value); }`);
function run(command, values, options = {}) {
  const result = spawnSync(command, values, { cwd: root, env: { ...process.env, IVAT_UPGRADE_MANIFEST: manifest }, stdio: "inherit", ...options });
  assert.equal(result.status, 0, `${command} failed (${result.status})`);
}
async function databaseObservation() {
  const database = new Client({ connectionString: status.DB_URL });
  await database.connect();
  try {
    return { migrations: (await database.query("select version from supabase_migrations.schema_migrations order by version")).rows.map(row => row.version),
      clock: (await database.query("select pg_get_functiondef(to_regprocedure('private.current_business_date()')) as definition")).rows[0].definition,
      date: (await database.query("select (current_timestamp at time zone 'Europe/Prague')::date::text as date")).rows[0].date };
  } finally { await database.end(); }
}
function fixture(stageRoot, name) {
  const configuration = path.join(directory, `${name}.config.mjs`);
  fs.writeFileSync(configuration, `export default { root:${JSON.stringify(stageRoot)}, resolve:{alias:{'@':${JSON.stringify(path.join(stageRoot, "src"))}}}, test:{include:[${JSON.stringify(`tests/upgrade/document-review-${name}.fixture.ts`)}],globalSetup:[${JSON.stringify(setup)}],fileParallelism:false,maxWorkers:1,testTimeout:120000} };`);
  run(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", configuration], { cwd: stageRoot });
}
console.log(`Upgrade acceptance owns ivat-wt${slot}; private evidence directory: ${directory}`);
run(process.execPath, ["scripts/supabase.mjs", "db", "reset", "--local", "--version", BOUNDARY, "--no-seed"]);
const old = await databaseObservation();
assert.equal(old.migrations.at(-1), BOUNDARY);
assert.equal(old.clock, null, "Baseline must have no feature clock replacement");
fixture(baseline, "baseline");
run(process.execPath, ["scripts/supabase.mjs", "migration", "up", "--local"]);
const migrated = await databaseObservation();
const expected = fs.readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).map(file => file.split("_")[0]).sort();
assert.deepEqual(migrated.migrations, expected);
assert.match(migrated.clock, /statement_timestamp\(\) at time zone 'Europe\/Prague'/);
fixture(root, "current");
const restored = await databaseObservation();
assert.equal(restored.clock, migrated.clock, "Fixture must restore exact native business clock function");
assert.equal(restored.date, migrated.date, "Native date changed during bounded acceptance; rerun on one date");
assert(!fs.existsSync(".supabase-worktree/claim-clock-restore.json"));
const evidence = { baseline: BASELINE, revision: git("rev-parse", "HEAD"), workingTree: git("status", "--porcelain"),
  project: `ivat-wt${slot}`, boundary: BOUNDARY, migrationCount: restored.migrations.length,
  nativeClockRestored: true, nativeDate: restored.date, completedAt: new Date().toISOString() };
fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(evidence, null, 2));
fs.rmSync(context); // Keep technical fixture/result evidence without local service credentials.
console.log(JSON.stringify(evidence, null, 2));
