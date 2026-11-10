import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const helper = new URL("../auth-startup.mjs", import.meta.url).href;
function startup(program, options = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import {startOwningStackAgain} from ${JSON.stringify(helper)};
    try { startOwningStackAgain(JSON.parse(process.argv[1])); }
    catch(error) { console.error(error.message); process.exitCode=1; }
  `, JSON.stringify({ command: process.execPath, args: ["-e", program], ...options })], {
    encoding: "utf8", timeout: 5000,
  });
}

test("failed repeated startup explains nonzero exit with measured duration and safe process metadata", () => {
  const result = startup("process.stderr.write('database unavailable\\n');process.exit(19)");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Owning stack repeated startup failed.*nonzero_exit/);
  assert.match(result.stderr, /elapsed_ms=\d+.*status=19.*signal=none.*code=none/);
  assert.match(result.stderr, /database unavailable/);
});

test("successful repeated startup remains silent", () => {
  const result = startup("process.stdout.write('healthy stack\\n');process.stderr.write('provider progress\\n')");
  assert.equal(result.status, 0);
  assert.equal(result.stdout + result.stderr, "");
});

test("failed startup redacts complete captured output before keeping a fixed-size diagnostic tail", () => {
  const output = 'progress '.repeat(1000) + '\nPassword: ' + 'synthetic-private-value '.repeat(150) + '\nFinal safe diagnostic\n';
  const result = startup(`process.stdout.write(${JSON.stringify(output)});process.exit(7)`);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.includes("synthetic-private-value"), false);
  assert(result.stderr.length < 2600);
  assert.match(result.stderr, /Final safe diagnostic/);
});

test("timeout, process signal and unlaunchable executable have distinct measured diagnostics", () => {
  const timeout = startup("process.stdout.write('waiting for readiness\\n');setInterval(()=>{},1000)", { timeout: 100 });
  assert.match(timeout.stderr, /failed: timeout; elapsed_ms=\d+; status=null; signal=SIGTERM; code=ETIMEDOUT/);
  assert.match(timeout.stderr, /waiting for readiness/);
  const elapsed = Number(timeout.stderr.match(/elapsed_ms=(\d+)/)?.[1]);
  assert(elapsed >= 80);
  const signal = startup("process.kill(process.pid,'SIGTERM')");
  assert.match(signal.stderr, /failed: signal; elapsed_ms=\d+; status=null; signal=SIGTERM; code=none/);
  const absent = startup("", { command: "/definitely-not-an-ivat-executable" });
  assert.match(absent.stderr, /failed: spawn_error; elapsed_ms=\d+; status=null; signal=none; code=ENOENT/);
});

test("capture overflow is explicit and drops possibly truncated credential output", () => {
  const result = startup("process.stdout.write('opaque-overflow-credential\\n'.repeat(100000));process.exitCode=4");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed: output_limit;.*code=ENOBUFS/);
  assert.match(result.stderr, /output omitted: capture limit exceeded/);
  assert.equal(result.stderr.includes("opaque-overflow-credential"), false);
  assert(result.stderr.length < 2600);
});

test("startup errors redact synthetic keys, JWTs and login credentials from both captured streams", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.syntheticSignature";
  const stdout = `sb_secret_syntheticKey\n${jwt}\npostgresql://local:synthetic/password@127.0.0.1:5432/postgres\n`;
  const stderr = "Authorization: Bearer synthetic-opaque-token\nAPI URL: http://127.0.0.1:54321\n";
  const result = startup(`process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exit(9)`);
  assert.equal(result.status, 1);
  assert.equal(/synthetic|eyJ|local:/.test(result.stderr), false);
  assert.match(result.stderr, /http:\/\/127\.0\.0\.1:54321/);
  assert.match(result.stderr, /\[REDACTED\]/);
});
