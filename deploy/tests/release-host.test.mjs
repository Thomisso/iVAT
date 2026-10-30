import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createReleaseBundle } from "../scripts/release-bundle.mjs";
import { spawnSimulation } from "./simulation-process.mjs";

const root = process.cwd();
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ivat-host-policy-"));
  const bundle = path.join(directory, "bundle");
  const stack = path.join(directory, "stack");
  await mkdir(path.join(stack, "deploy/backups"), { recursive: true });
  await writeFile(path.join(stack, ".env"), "SUPABASE_PUBLIC_URL=https://api.ivat.cz\nANON_KEY=sb_publishable_test\n");
  const compose = JSON.parse(execFileSync("docker", ["compose", "-f", "docker-compose.rosti.yml", "config", "--no-interpolate", "--no-path-resolution", "--format", "json"], { encoding: "utf8" }));
  const images = Object.fromEntries(["app", "db", "gateway", "proxy"].map(name => [name, `ghcr.io/thomisso/ivat/${name}@sha256:${"a".repeat(64)}`]));
  await createReleaseBundle({ sourceDirectory: root, outputDirectory: bundle, release: { repository: "thomisso/ivat", revision: "1".repeat(40), tag: "v0.2.0", releaseId: 155 }, publicBuild: { supabaseUrl: "https://api.ivat.cz", publishableKey: "sb_publishable_test" }, images, compose });
  return { directory, bundle, stack };
}

test("release preflight refuses an installation without a completed daily backup", async () => {
  const f = await fixture();
  try {
    const original = await readFile(path.join(f.stack, ".env"), "utf8");
    const result = spawnSync(process.execPath, ["deploy/scripts/release-host.mjs", "preflight", f.bundle, f.stack], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /completed daily backup/);
    assert.equal(await readFile(path.join(f.stack, ".env"), "utf8"), original);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

async function backup(f, hoursOld = 0, content = gzipSync("test archive")) {
  const date = new Date(Date.now() - hoursOld * 3600000);
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const file = path.join(f.stack, "deploy/backups", `ivat-${stamp}.tar.gz`);
  await writeFile(file, content);
  await writeFile(file + ".images.json", JSON.stringify([{ ID: "sha256:" + "b".repeat(64) }]));
  await utimes(file, date, date);
  return file;
}

test("preflight accepts a recent complete archive and refuses stale, incomplete, corrupt or mismatched settings", async () => {
  const f = await fixture();
  const check = () => spawnSync(process.execPath, ["deploy/scripts/release-host.mjs", "preflight", f.bundle, f.stack], { encoding: "utf8" });
  try {
    const archive = await backup(f);
    assert.equal(check().status, 0);
    const stale = new Date(Date.now() - 27 * 3600000);
    await utimes(archive, stale, stale);
    assert.match(check().stderr, /older than 26 hours/);
    await utimes(archive, new Date(), new Date());
    await rm(archive + ".images.json");
    assert.match(check().stderr, /image inventory/);
    await writeFile(archive + ".images.json", "[]");
    assert.match(check().stderr, /image inventory/);
    await writeFile(archive + ".images.json", JSON.stringify([{ Repository: "not-an-image-identity" }]));
    assert.match(check().stderr, /image inventory/);
    await writeFile(archive + ".images.json", JSON.stringify([{ ID: "sha256:" + "b".repeat(64) }]));
    await writeFile(archive, "not a gzip archive");
    assert.match(check().stderr, /corrupt/);
    await writeFile(archive, gzipSync("test archive"));
    await writeFile(path.join(f.stack, ".env"), "SUPABASE_PUBLIC_URL=https://wrong.ivat.cz\nANON_KEY=sb_publishable_test\n");
    assert.match(check().stderr, /public build settings/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("provider synchronization verifies stored Compose and never exposes provider secrets on refusal", async () => {
  const f = await fixture();
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const net = createServer();
  await new Promise(resolve => net.listen(0, "127.0.0.1", resolve));
  const port = net.address().port;
  await new Promise(resolve => net.close(resolve));
  const { child: simulation, stop } = spawnSimulation("postman/simulations/rosti-deployment/rosti-deployment.sim.yaml", port);
  let log = "";
  simulation.stdout.on("data", chunk => { log += chunk; });
  simulation.stderr.on("data", chunk => { log += chunk; });
  const api = `http://127.0.0.1:${port}/rosti`;
  try {
    const deadline = Date.now() + 15000;
    while (!log.includes('"type":"listening"') && !log.includes('"event":"listening"')) {
      if (Date.now() > deadline || simulation.exitCode !== null) throw new Error("Simulation did not start: " + log);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await mkdir(path.join(f.stack, "deploy/attempts/test"), { recursive: true });
    const run = () => new Promise(resolve => {
      const child = spawn(process.execPath, ["deploy/scripts/release-host.mjs", "sync", f.bundle, f.stack, "deploy/attempts/test"], { env: { ...process.env, ROSTI_API_URL: api + "/api-n", ROSTI_API_KEY: "test-provider-secret", ROSTI_TIMEOUT_MS: "200" } });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
      child.on("exit", status => resolve({ status, stdout, stderr }));
    });
    const control = behavior => fetch(api + "/__control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ behavior }) });
    await control("success");
    assert.equal((await run()).status, 0);
    const response = await fetch(api + "/api-n/7895/stacks/931", { headers: { "x-api-key": "test-provider-secret" } });
    assert.equal(Buffer.from((await response.json()).compose_b64, "base64").toString(), await readFile(path.join(f.bundle, "docker-compose.rosti.yml"), "utf8"));
    for (const behavior of ["locked", "html", "mismatch", "timeout-after-write"]) {
      await control(behavior);
      const result = await run();
      assert.equal(result.status, 1, behavior);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_PROVIDER|test-provider-secret/);
      assert.match(result.stderr, /Rošti/);
    }
    assert.match(log, /request/);
  } finally {
    try { await stop(); }
    finally { await rm(f.directory, { recursive: true, force: true }); }
  }
});

test("a deployment bundle cannot omit its controlled entrypoint", async () => {
  const f = await fixture();
  try {
    const manifestFile = path.join(f.bundle, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    delete manifest.files["deploy/scripts/deploy-release.sh"];
    await rm(path.join(f.bundle, "deploy/scripts/deploy-release.sh"));
    await writeFile(manifestFile, JSON.stringify(manifest));
    const { validateReleaseBundle } = await import("../scripts/release-bundle.mjs");
    await assert.rejects(validateReleaseBundle(f.bundle), /Missing required release asset/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("selected-image inspection refuses incomplete configuration without producing a partial verification list", () => {
  const run = services => spawnSync(process.execPath, ["deploy/scripts/release-host.mjs", "selected-images"], { input: JSON.stringify({ services }), encoding: "utf8" });
  const services = Object.fromEntries(["web", "worker", "migrate", "db", "gateway", "proxy"].map(name => [name, { image: "local-image:verify" }]));
  const valid = run(services);
  assert.equal(valid.status, 0);
  assert.equal(valid.stdout.trim().split("\n").length, 6);
  delete services.worker;
  const refused = run(services);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
});

test("the public probe preserves application Host routing in a disposable HTTP fixture", async () => {
  const f = await fixture();
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const server = createServer((request, response) => { response.statusCode = request.headers.host === "app.ivat.cz" && request.headers["x-forwarded-proto"] === "https" ? 200 : 404; response.end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await writeFile(path.join(f.stack, ".env"), "APP_ORIGIN=https://app.ivat.cz\n");
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, ["deploy/scripts/release-host.mjs", "probe", f.bundle, f.stack], { env: { ...process.env, IVAT_DISPOSABLE_DEPLOYMENT: "1", IVAT_DEPLOY_PUBLIC_URL: `http://127.0.0.1:${server.address().port}/login` } });
      let stderr = ""; child.stderr.on("data", data => { stderr += data; }); child.on("exit", status => resolve({ status, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(f.directory, { recursive: true, force: true }); }
});
