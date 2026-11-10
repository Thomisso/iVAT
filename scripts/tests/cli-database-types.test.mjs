import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const sourceNames = ["generate-database-types.mjs", "supabase.mjs", "supabase-status.mjs", "cli-output.mjs"];

function fixture(t, program) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ivat-type-generation-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q", "-b", "main");
  function checkout(directory) {
    for (const name of ["scripts", "src/lib", "supabase", "node_modules/.bin"]) mkdirSync(path.join(directory, name), { recursive: true });
    for (const name of sourceNames) copyFileSync(new URL(`../${name}`, import.meta.url), path.join(directory, "scripts", name));
    writeFileSync(path.join(directory, "supabase/config.toml"), 'project_id = "fixture"\n');
    const executable = path.join(directory, "node_modules/.bin/supabase");
    writeFileSync(executable, `#!${process.execPath}\n${program}\n`); chmodSync(executable, 0o755);
    const output = path.join(directory, "src/lib/database.types.ts");
    writeFileSync(output, "previous generated types\n");
    return { directory, output, run: (env = {}) => spawnSync(process.execPath, ["scripts/generate-database-types.mjs"], { cwd: directory, encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, ...env } }) };
  }
  return { ...checkout(root), git, linked() {
    git("-c", "user.name=Type fixture", "-c", "user.email=types@example.test", "commit", "--allow-empty", "-qm", "Fixture");
    const directory = path.join(root, "linked");
    git("worktree", "add", "-q", "-b", "linked", directory);
    return checkout(directory);
  } };
}

test("the actual generator preserves api_key schema fields in its file without exposing raw stdout", t => {
  const raw = 'export type Configuration = {\r\n  "api_key": string,"configuration_id": string  \r\n}\r\n';
  const f = fixture(t, `process.stdout.write(${JSON.stringify(raw)});`);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.output, "utf8"), 'export type Configuration = {\n  "api_key": string,"configuration_id": string\n}\n');
  assert.equal(result.stdout, "");
  const publicOutput = spawnSync(process.execPath, ["scripts/supabase.mjs", "gen", "types", "typescript", "--local"], { cwd: f.directory, encoding: "utf8" });
  assert.equal(publicOutput.status, 0);
  assert.match(publicOutput.stdout, /"api_key": \[REDACTED\]/);
});


test("generator failures preserve status and previous file while publishing only redacted diagnostics", t => {
  const f = fixture(t, `process.stdout.write('partial generated source with sb_secret_private_output');
    process.stderr.write('Connection failed at 127.0.0.1:54322\\napi_key: opaque-private-key\\n');process.exit(23);`);
  const result = f.run();
  assert.equal(result.status, 23);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Connection failed at 127\.0\.0\.1:54322/);
  assert.match(result.stderr, /status=23/);
  assert.doesNotMatch(result.stderr, /opaque-private-key|sb_secret_private_output/);
  assert.equal(readFileSync(f.output, "utf8"), "previous generated types\n");
});

test("a missing generator executable reports a safe refusal and keeps the previous type file", t => {
  const f = fixture(t, "");
  rmSync(path.join(f.directory, "node_modules/.bin/supabase"));
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /code=ENOENT/);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(f.output, "utf8"), "previous generated types\n");
});

test("private generation selects the linked stack and its environment without changing the parent checkout", t => {
  const f = fixture(t, `if (!process.argv.includes(process.env.EXPECTED_WORKDIR) || process.env.FIXTURE_SETTING !== 'from-dotenv') process.exit(31);
    process.stdout.write('export type Configuration = { "api_key": string }\\n');`);
  const linked = f.linked();
  mkdirSync(path.join(linked.directory, ".supabase-worktree/supabase"), { recursive: true });
  writeFileSync(path.join(linked.directory, ".supabase-worktree/supabase/config.toml"), 'project_id = "fixture-linked"\n');
  writeFileSync(path.join(linked.directory, ".env"), 'FIXTURE_SETTING=from-dotenv\n');
  const result = linked.run({ EXPECTED_WORKDIR: path.join(linked.directory, ".supabase-worktree") });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(linked.output, "utf8"), 'export type Configuration = { "api_key": string }\n');
  assert.equal(readFileSync(f.output, "utf8"), "previous generated types\n");
  assert.equal(result.stdout, "");
});

test("capture overflow omits truncated diagnostic bytes and preserves the previous type file", t => {
  const f = fixture(t, `process.stderr.write('truncated-private-prefix' + 'x'.repeat(2 * 1024 * 1024));`);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /code=ENOBUFS/);
  assert.doesNotMatch(result.stderr, /truncated-private-prefix/);
  assert.ok(result.stderr.length < 512);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(f.output, "utf8"), "previous generated types\n");
});
