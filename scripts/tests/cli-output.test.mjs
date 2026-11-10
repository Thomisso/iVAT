import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(t, program) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ivat-cli-output-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  for (const name of ["supabase.mjs", "cli-output.mjs", "supabase-status.mjs"]) {
    const source = new URL(`../${name}`, import.meta.url);
    if (existsSync(source)) copyFileSync(source, path.join(root, "scripts", name));
  }
  mkdirSync(path.join(root, "supabase"));
  writeFileSync(path.join(root, "supabase/config.toml"), 'project_id = "fixture"\n');
  execFileSync("git", ["init", "-q"], { cwd: root });
  const executable = path.join(root, "node_modules/.bin/supabase");
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, `#!${process.execPath}\n${program}\n`);
  chmodSync(executable, 0o755);
  return { root, run: (args = ["status"], env = {}) => spawnSync(process.execPath, ["scripts/supabase.mjs", ...args], {
    cwd: root, encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, ...env },
  }) };
}

test("public Supabase output redacts both streams and preserves failed-command diagnostics and status", t => {
  const f = fixture(t, `process.stdout.write('API URL: http://127.0.0.1:54321\\nPublishable key: sb_publishable_fixture123\\n');
    process.stderr.write('Startup failed: sb_secret_fixture456\\n');process.exit(17);`);
  const result = f.run();
  assert.equal(result.status, 17);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:54321/);
  assert.match(result.stderr, /Startup failed/);
  assert.doesNotMatch(result.stdout + result.stderr, /sb_publishable_fixture123|sb_secret_fixture456/);
  assert.match(result.stdout + result.stderr, /\[REDACTED\]/);
  assert.doesNotMatch(result.stdout + result.stderr, /\[REDACTED\]\]/);
});

test("current CLI JSON, env and boxed-table credentials are redacted while service addresses survive", t => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.syntheticSignature";
  const output = [
    JSON.stringify({ JWT_SECRET: 'opaque-signing-"quoted"-secret', S3_PROTOCOL_ACCESS_KEY_ID: "opaque-s3-id", S3_PROTOCOL_ACCESS_KEY_SECRET: "opaque-s3-secret", API_URL: "http://127.0.0.1:54321" }),
    'SERVICE_ROLE_KEY="opaque-service-key"',
    "│ Access Key │ opaque-table-key │",
    "anon key: " + jwt,
    "DB_URL=postgresql://postgres:opaque-db-pass@127.0.0.1:54322/postgres",
    "stderr token sb_secret_ansi\u001b[31msuffix\u001b[0m",
  ].join("\n");
  const f = fixture(t, `process.stdout.write(${JSON.stringify(output)});`);
  const result = f.run();
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /opaque-|quoted|syntheticSignature|sb_secret_|ansisuffix/);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:54321/);
  assert.match(result.stdout, /127\.0\.0\.1:54322\/postgres/);
});

test("split secret chunks and oversized unterminated output never escape the public streams", t => {
  const f = fixture(t, `process.stdout.write('sb_se');
    setTimeout(() => { process.stdout.write('cret_split-secret\\n');
      process.stderr.write('x'.repeat(70000) + 'opaque-overlong-tail'); }, 20);`);
  const result = f.run();
  assert.equal(result.status, 0);
  assert.equal(/sb_se|split-secret|opaque-overlong-tail/.test(result.stdout + result.stderr), false);
  assert.match(result.stderr, /oversized CLI line omitted/);
  assert(result.stderr.length < 1000);
});

const stack = { API_URL: "http://127.0.0.1:54321", PUBLISHABLE_KEY: "sb_publishable_fixture", SECRET_KEY: "sb_secret_fixture", JWT_SECRET: "opaque-jwt-fixture", DB_URL: "postgresql://postgres:opaque-db-fixture@127.0.0.1:54322/postgres" };

test("private status consumers and env configuration retain original credentials without a public raw-output switch", t => {
  const f = fixture(t, `process.stdout.write(${JSON.stringify(JSON.stringify(stack))});`);
  const started = f.run(["start"]);
  assert.equal(started.status, 0, started.stderr);
  assert.doesNotMatch(started.stdout, /sb_publishable_fixture|sb_secret_fixture|opaque-/);
  const env = readFileSync(path.join(f.root, ".env.local"), "utf8");
  assert.match(env, /SUPABASE_SECRET_KEY=sb_secret_fixture/);
  assert.match(env, /DATABASE_URL=postgresql:\/\/postgres:opaque-db-fixture@/);
  const status = f.run(["status", "-o", "json"]);
  assert.equal(JSON.parse(status.stdout).SECRET_KEY, "[REDACTED]");
  writeFileSync(path.join(f.root, "private-consumer.mjs"), `import {readSupabaseStatus} from './scripts/supabase-status.mjs';
    const status=readSupabaseStatus();console.log(JSON.stringify({secret:status.SECRET_KEY==='sb_secret_fixture',database:status.DB_URL.includes('opaque-db-fixture')}));`);
  const consumed = spawnSync(process.execPath, ["private-consumer.mjs"], { cwd: f.root, encoding: "utf8" });
  assert.equal(consumed.status, 0, consumed.stderr);
  assert.deepEqual(JSON.parse(consumed.stdout), { secret: true, database: true });
});

test("status failure and malformed private responses never attach credential output to errors", t => {
  for (const mode of ["failure", "invalid"]) {
    const f = fixture(t, `if(process.argv[2]==='status') {
      process.stdout.write('opaque-private-status-secret');process.stderr.write('opaque-private-error-secret');process.exit(${mode === "failure" ? 23 : 0});
    } else process.stdout.write('Started local stack\\n');`);
    const result = f.run(["start"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, mode === "failure" ? /status failed.*status=23/ : /invalid JSON/);
    assert.doesNotMatch(result.stdout + result.stderr, /opaque-private/);
  }
});

test("missing executable and signalled CLI preserve honest process outcomes", t => {
  const missing = fixture(t, "");
  rmSync(path.join(missing.root, "node_modules/.bin/supabase"));
  const refused = missing.run();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /could not start \(ENOENT\)/);
  const signalled = fixture(t, `process.stdout.write('safe progress\\n');process.kill(process.pid, 'SIGTERM');`);
  const result = signalled.run();
  assert.equal(result.signal, "SIGTERM");
  assert.match(result.stdout, /safe progress/);
});

test("public and private status use only the linked worktree stack and preserve env settings", t => {
  const f = fixture(t, `const expected=process.env.EXPECTED_WORKDIR;
    if(!process.argv.includes(expected)||process.env.FIXTURE_SETTING!=='from-dotenv')process.exit(31);
    process.stdout.write(${JSON.stringify(JSON.stringify(stack))});`);
  execFileSync("git", ["-c", "user.name=CLI fixture", "-c", "user.email=cli@example.test", "commit", "--allow-empty", "-qm", "Fixture"], { cwd: f.root });
  const linked = path.join(f.root, "linked");
  execFileSync("git", ["worktree", "add", "-q", "-b", "linked", linked], { cwd: f.root });
  for (const directory of ["scripts", "supabase", "node_modules/.bin"]) mkdirSync(path.join(linked, directory), { recursive: true });
  for (const name of ["supabase.mjs", "cli-output.mjs", "supabase-status.mjs"]) copyFileSync(path.join(f.root, "scripts", name), path.join(linked, "scripts", name));
  copyFileSync(path.join(f.root, "node_modules/.bin/supabase"), path.join(linked, "node_modules/.bin/supabase"));
  copyFileSync(path.join(f.root, "supabase/config.toml"), path.join(linked, "supabase/config.toml"));
  writeFileSync(path.join(linked, ".env"), "FIXTURE_SETTING=from-dotenv\nSUPABASE_SLOT=91\n");
  writeFileSync(path.join(linked, ".env.local"), "EXISTING_SETTING=keep-me\n");
  const env = { PATH: process.env.PATH, EXPECTED_WORKDIR: path.join(linked, ".supabase-worktree") };
  const result = spawnSync(process.execPath, ["scripts/supabase.mjs", "start"], { cwd: linked, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(path.join(linked, ".supabase-worktree/supabase/config.toml"), "utf8"), /project_id = "ivat-wt91"/);
  assert.match(readFileSync(path.join(linked, ".env.local"), "utf8"), /EXISTING_SETTING=keep-me/);
  assert.equal(existsSync(path.join(f.root, ".env.local")), false);
});

test("provider-style token and database-password labels cannot leak opaque credentials in CLI errors", t => {
  const output = 'SUPABASE_ACCESS_TOKEN="opaque-access-credential"\nPOSTGRES_PASSWORD=opaque-password-credential\nrefresh_token: opaque-refresh-credential\n';
  const f = fixture(t, `process.stderr.write(${JSON.stringify(output)});process.exit(2);`);
  const result = f.run();
  assert.equal(result.status, 2);
  assert.equal(result.stderr.includes("opaque-"), false);
  assert.match(result.stderr, /SUPABASE_ACCESS_TOKEN/);
});

test("complete authorization/password values and URL userinfo are hidden even when they contain spaces or slashes", t => {
  const output = 'Authorization: Bearer synthetic-opaque-token\nPassword: synthetic password with spaces,commas}suffix|pipe-suffix\npostgresql://local:synthetic/password@127.0.0.1:5432/postgres\n';
  const f = fixture(t, `process.stderr.write(${JSON.stringify(output)});process.exit(3);`);
  const result = f.run();
  assert.equal(result.status, 3);
  assert.equal(/synthetic|password with|commas|suffix/.test(result.stderr), false);
  assert.match(result.stderr, /127\.0\.0\.1:5432\/postgres/);
});
