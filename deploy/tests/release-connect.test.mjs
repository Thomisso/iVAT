import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { createReleaseBundle } from "../scripts/release-bundle.mjs";
import { deployPreparedRelease, inspectReleaseArchive } from "../scripts/connect-release.mjs";
import { waitForRequiredChecks } from "../scripts/prepare-release.mjs";
import { spawnSimulation } from "./simulation-process.mjs";

test("the downloaded archive must be the exact verified Release before transport is possible", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "ivat-connect-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const verified = { repository: "thomisso/ivat", revision: "a".repeat(40), tag: "v0.2.0", releaseId: 156 };
  const event = { action: "published", repository: { full_name: "Thomisso/iVAT" }, release: { id: 156, tag_name: "v0.2.0", draft: false, prerelease: false } };
  const images = Object.fromEntries(["app", "db", "gateway", "proxy"].map(name => [name, `ghcr.io/thomisso/ivat/${name}@sha256:${"b".repeat(64)}`]));
  const compose = JSON.parse(execFileSync("docker", ["compose", "-f", "docker-compose.rosti.yml", "config", "--no-interpolate", "--no-path-resolution", "--format", "json"], { encoding: "utf8" }));
  const bundle = path.join(directory, "bundle");
  await createReleaseBundle({ sourceDirectory: process.cwd(), outputDirectory: bundle, release: verified, images, compose, publicBuild: { supabaseUrl: "https://api.ivat.cz", publishableKey: "sb_publishable_connection_test" } });
  const archive = path.join(directory, "release.tar.gz");
  execFileSync("tar", ["--format", "ustar", "-czf", archive, "-C", bundle, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const bytes = await readFile(archive);
  assert.equal((await inspectReleaseArchive(bytes, verified, event)).revision, verified.revision);
  await assert.rejects(inspectReleaseArchive(bytes, { ...verified, revision: "c".repeat(40) }, event), /does not match/);
  await assert.rejects(inspectReleaseArchive(bytes, verified, { ...event, release: { ...event.release, id: 157 } }), /does not match/);
  await assert.rejects(inspectReleaseArchive(bytes, verified, { ...event, release: { ...event.release, prerelease: true } }), /published stable/);
  await assert.rejects(deployPreparedRelease({ archive: bytes, verified, event, ssh: { host: "127.0.0.1", port: 22, user: "root", privateKey: "test-only", knownHosts: "test-only" }, actor: "release-test", attemptId: "missing-project" }), /Invalid reviewed SSH\/deployment configuration/);
});

test("the detached launcher records early failure and refuses duplicate attempt IDs", async t => {
  execFileSync("docker", ["build", "-q", "-f", "deploy/tests/operator.Dockerfile", "-t", "ivat-release155-operator:verify", "."], { stdio: "pipe" });
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ivat-launch-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, "bundle");
  await mkdir(path.join(bundle, "deploy/scripts"), { recursive: true });
  await copyFile("deploy/scripts/launch-release.sh", path.join(bundle, "deploy/scripts/launch-release.sh"));
  await writeFile(path.join(bundle, "deploy/scripts/deploy-release.sh"), '#!/bin/bash\nread -r registry; read -r provider; [[ "$registry" == REGISTRY_PRIVATE && "$provider" == PROVIDER_PRIVATE ]] || exit 99\ntouch "$1/deploy/transports/$IVAT_DEPLOY_ATTEMPT_ID/credentials-received"\nsleep 0.1\nexit 17\n');
  const fixtureUser = ["--user", `${process.getuid()}:${process.getgid()}`];
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn("docker", ["run", "--rm", "-i", ...fixtureUser, "-v", `${directory}:${directory}`, "ivat-release155-operator:verify", "-c", 'bash "$1/deploy/scripts/launch-release.sh" start "$2" "$1" stack test-123 release-test || exit; while [ "$(cat "$2/deploy/transports/test-123/result")" = running ]; do sleep 0.1; done', "bash", bundle, directory]);
    let output = "";
    child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
    child.on("exit", status => resolve({ status, output }));
    child.on("error", reject);
    child.stdin.end("REGISTRY_PRIVATE\nPROVIDER_PRIVATE\n");
  });
  const result = await launch();
  assert.equal(result.status, 0, result.output);
  const transport = path.join(directory, "deploy/transports/test-123");
  let status;
  for (let poll = 0; poll < 100; poll++) {
    status = (await readFile(path.join(transport, "result"), "utf8")).trim();
    if (status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(status, "failed");
  await readFile(path.join(transport, "credentials-received"));
  assert.doesNotMatch(result.output, /REGISTRY_PRIVATE|PROVIDER_PRIVATE/);
  assert.notEqual((await launch()).status, 0);
  assert.equal((await readFile(path.join(transport, "result"), "utf8")).trim(), "failed");
  await assert.rejects(readFile(path.join(transport, "credentials")), { code: "ENOENT" });
  await writeFile(path.join(directory, "test-input"), "REGISTRY_PRIVATE\nPROVIDER_PRIVATE\n", { mode: 0o600 });
  const stress = execFileSync("docker", ["run", "--rm", ...fixtureUser, "-v", `${directory}:${directory}`, "ivat-release155-operator:verify", "-c", 'for i in $(seq 1 100); do bash "$1/deploy/scripts/launch-release.sh" start "$2" "$1" stack "race-$i" release-test < "$2/test-input" >/dev/null & done; wait; sleep 2; for i in $(seq 1 100); do test -f "$2/deploy/transports/race-$i/credentials-received" || exit 42; done', "bash", bundle, directory], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(stress, "");
});

test("GitHub HTTP evidence stand-in cannot authorize wrong, failed or incomplete main checks", async t => {
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const { child: simulation, stop } = spawnSimulation("postman/simulations/release-flow/release-flow.sim.yaml", port);
  t.after(stop);
  let log = ""; simulation.stdout.on("data", bytes => { log += bytes; }); simulation.stderr.on("data", bytes => { log += bytes; });
  const deadline = Date.now() + 15000;
  while (!log.includes('"type":"listening"') && !log.includes('"event":"listening"')) {
    if (Date.now() > deadline || simulation.exitCode !== null) throw new Error("Release simulation failed to start.");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const options = { repository: "thomisso/ivat", revision: "a".repeat(40), token: "PRIVATE_TEST_GITHUB_TOKEN", apiUrl: `http://127.0.0.1:${port}/github`, timeoutMs: 300, pollMs: 5 };
  const control = behavior => fetch(options.apiUrl + "/__control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ behavior, revision: options.revision }) });
  await control("eventually-success"); await waitForRequiredChecks(options);
  for (const behavior of ["failed", "wrong-sha", "pr-only", "missing", "pending", "forbidden", "html", "malformed", "timeout"]) {
    await control(behavior);
    await assert.rejects(waitForRequiredChecks(options), error => {
      assert.doesNotMatch(error.message, /PRIVATE_/);
      return /did not succeed|Timed out|GitHub workflow evidence/.test(error.message);
    }, behavior);
  }
  assert.match(log, /ci\.yml/); assert.match(log, /deployment-check\.yml/);
});
