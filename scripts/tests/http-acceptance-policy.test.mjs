import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import test from "node:test";

const runner = new URL("../e2e.mjs", import.meta.url).pathname;

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "ivat-http-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "main"); mkdirSync(main);
  const git = (...args) => execFileSync("git", args, { cwd: main, stdio: "pipe" });
  git("init", "-b", "main");
  git("-c", "user.name=HTTP test", "-c", "user.email=http@example.test", "commit", "--allow-empty", "-m", "Fixture");
  const worktree = path.join(root, "ticket"); git("worktree", "add", worktree, "-b", "ticket");
  const bin = path.join(root, "bin"); mkdirSync(bin);
  const tripwire = path.join(root, "npm-invoked");
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh
touch '${tripwire}'
exit 91
`); chmodSync(path.join(bin, "npm"), 0o755);
  return { main, worktree, tripwire, run: (cwd, args = [], extra = {}) => spawnSync(process.execPath, [runner, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, CI: "", GITHUB_ACTIONS: "", IVAT_HTTP_BASE_URL: "http://127.0.0.1:3150", PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...extra },
  }) };
}

test("the actual runner refuses a human main checkout before any database command", t => {
  const f = fixture(t);
  const result = f.run(f.main);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /never the human checkout/);
  assert.equal(existsSync(f.tripwire), false);
});

test("the actual runner rejects legacy browser arguments and nonlocal origins before database work", t => {
  const f = fixture(t);
  const legacy = f.run(f.worktree, ["--project=chromium"]);
  assert.equal(legacy.status, 1); assert.match(legacy.stderr, /accepts only --dev-server/);
  for (const origin of ["https://127.0.0.1:3150", "http://example.com:3150", "http://127.0.0.1:3150/path", "http://127.0.0.1:3150?target=other"]) {
    const result = f.run(f.worktree, [], { IVAT_HTTP_BASE_URL: origin });
    assert.equal(result.status, 1); assert.match(result.stderr, /unused http:\/\/127\.0\.0\.1:PORT origin/);
  }
  assert.equal(existsSync(f.tripwire), false);
});

test("normal package and CI entry points select real production HTTP acceptance without browser launch/install", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["test:e2e"], "node scripts/e2e.mjs");
  assert.equal(packageJson.scripts["test:http"], "node scripts/e2e.mjs");
  const source = readFileSync(runner, "utf8");
  assert.match(source, /Build production application/);
  assert.match(source, /vitest.http.config.ts/);
  assert.doesNotMatch(source, /\["playwright"|playwright.*test|chromium.*launch|browser_eval/);
  assert.match(readFileSync(new URL("../../vitest.http.config.ts", import.meta.url), "utf8"), /acceptance\/\*\*\/\*\.test\.ts/);
});

test("a bound server port refuses before touching the disposable database", async t => {
  const f = fixture(t);
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = f.run(f.worktree, [], { IVAT_HTTP_BASE_URL: `http://127.0.0.1:${server.address().port}` });
  assert.equal(result.status, 1); assert.match(result.stderr, /EADDRINUSE/);
  assert.equal(existsSync(f.tripwire), false);
});

test("a partial owned database startup failure still runs actual runner cleanup", t => {
  const f = fixture(t);
  const bin = path.join(path.dirname(f.worktree), "bin");
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh
printf '%s\\n' "$*" >> '${f.tripwire}'
case "$*" in *db:start*) exit 91;; *) exit 0;; esac
`);
  const result = f.run(f.worktree, [], { IVAT_HTTP_BASE_URL: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exited with 91/);
  const calls = readFileSync(f.tripwire, "utf8").trim().split("\n");
  assert.deepEqual(calls, ["run db:stop -- --no-backup", "run db:start -- --profile=e2e", "run db:stop -- --no-backup"]);
});
