import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  for (const implementation of ["gnu", "busybox"]) await t.test(implementation, async t => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ivat-launch-")));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bundle = path.join(directory, "bundle");
    await mkdir(path.join(bundle, "deploy/scripts"), { recursive: true });
    await copyFile("deploy/scripts/launch-release.sh", path.join(bundle, "deploy/scripts/launch-release.sh"));
    await writeFile(path.join(bundle, "deploy/scripts/deploy-release.sh"), '#!/bin/bash\nread -r registry; read -r provider; [[ "$registry" == REGISTRY_PRIVATE && "$provider" == PROVIDER_PRIVATE ]] || exit 99\ntouch "$1/deploy/transports/$IVAT_DEPLOY_ATTEMPT_ID/credentials-received"\nsleep 0.1\nexit 17\n');
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "timeout"), `#!/bin/sh\nexec ${implementation === "busybox" ? "/bin/busybox timeout" : "/usr/bin/timeout"} "$@"\n`, { mode: 0o755 });
    const fixturePath = ["-e", `PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`];
    const fixtureUser = ["--user", `${process.getuid()}:${process.getgid()}`];
    const launch = () => new Promise((resolve, reject) => {
      const child = spawn("docker", ["run", "--rm", "-i", ...fixtureUser, ...fixturePath, "-v", `${directory}:${directory}`, "ivat-release155-operator:verify", "-c", 'bash "$1/deploy/scripts/launch-release.sh" start "$2" "$1" stack test-123 release-test || exit; while [ "$(cat "$2/deploy/transports/test-123/result")" = running ]; do sleep 0.1; done', "bash", bundle, directory]);
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
    const stress = execFileSync("docker", ["run", "--rm", ...fixtureUser, ...fixturePath, "-v", `${directory}:${directory}`, "ivat-release155-operator:verify", "-c", 'for i in $(seq 1 100); do bash "$1/deploy/scripts/launch-release.sh" start "$2" "$1" stack "race-$i" release-test < "$2/test-input" >/dev/null & done; wait; sleep 2; for i in $(seq 1 100); do test -f "$2/deploy/transports/race-$i/credentials-received" || exit 42; done', "bash", bundle, directory], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(stress, "");
  });
});

test("GNU and BusyBox deadlines deliver TERM and allow deployment cleanup to finish", async t => {
  execFileSync("docker", ["build", "-q", "-f", "deploy/tests/operator.Dockerfile", "-t", "ivat-release155-operator:verify", "."], { stdio: "pipe" });
  for (const implementation of ["gnu", "busybox"]) await t.test(implementation, async t => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ivat-launch-term-")));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const scripts = path.join(directory, "bundle/deploy/scripts");
    const transport = path.join(directory, "deploy/transports/term-test");
    await mkdir(scripts, { recursive: true });
    await mkdir(transport, { recursive: true });
    const launcher = await readFile("deploy/scripts/launch-release.sh", "utf8");
    assert.equal(launcher.split("2700 bash").length, 2, "accelerate only the host deadline");
    await writeFile(path.join(scripts, "launch-release.sh"), launcher.replace("2700 bash", "1 bash"));
    await writeFile(path.join(scripts, "deploy-release.sh"), `#!/bin/bash
trap 'sleep 2; touch "$1/deploy/transports/term-test/cleanup-finished"; exit 143' TERM
touch "$1/deploy/transports/term-test/started"
while true; do sleep 0.1; done
`);
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "timeout"), `#!/bin/sh\nexec ${implementation === "busybox" ? "/bin/busybox timeout" : "/usr/bin/timeout"} "$@"\n`, { mode: 0o755 });
    const result = await new Promise((resolve, reject) => {
      const child = spawn("docker", ["run", "--rm", "--user", `${process.getuid()}:${process.getgid()}`, "-e", `PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, "-v", `${directory}:${directory}`, "ivat-release155-operator:verify", path.join(scripts, "launch-release.sh"), "run", directory, path.join(directory, "bundle"), "stack", "term-test", "release-test"], { timeout: 20000 });
      let output = "";
      child.stdout.on("data", bytes => { output += bytes; });
      child.stderr.on("data", bytes => { output += bytes; });
      child.on("error", reject);
      child.on("exit", status => resolve({ status, output }));
    });
    assert.notEqual(result.status, 0, result.output);
    await readFile(path.join(transport, "started"));
    await readFile(path.join(transport, "cleanup-finished"));
    assert.equal((await readFile(path.join(transport, "result"), "utf8")).trim(), "failed");
  });
});

test("deployment reaches bundle preflight with GNU and BusyBox host tools", async t => {
  execFileSync("docker", ["build", "-q", "-f", "deploy/tests/operator.Dockerfile", "-t", "ivat-release155-operator:verify", "."], { stdio: "pipe" });
  for (const implementation of ["gnu", "busybox"]) await t.test(implementation, async t => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ivat-lock-preflight-")));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, "bundle/deploy"), { recursive: true });
    await cp("deploy/scripts", path.join(directory, "bundle/deploy/scripts"), { recursive: true });
    await writeFile(path.join(directory, "bundle/manifest.json"), "{}\n");
    await mkdir(path.join(directory, "stack"));
    await writeFile(path.join(directory, "stack/.env"), "");
    await writeFile(path.join(directory, "stack/docker-compose.rosti.yml"), "");
    const result = spawnSync("docker", ["run", "--rm", "-e", `PATH=${implementation === "busybox" ? "/opt/ivat-busybox:" : ""}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, "-v", `${directory}:${directory}`, "-v", `${process.cwd()}:/source:ro`, "ivat-release155-operator:verify", path.join(directory, "bundle/deploy/scripts/deploy-release.sh"), path.join(directory, "stack"), path.join(directory, "bundle"), "stack"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid release helper image/);
    assert.doesNotMatch(result.stderr, /unrecognized option|Deployment lock unavailable/);
  });
});

test("GNU and BusyBox lock retries refuse contention and retain ownership through TERM cleanup", async t => {
  execFileSync("docker", ["build", "-q", "-f", "deploy/tests/operator.Dockerfile", "-t", "ivat-release155-operator:verify", "."], { stdio: "pipe" });
  for (const implementation of ["gnu", "busybox"]) await t.test(implementation, async t => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ivat-shared-lock-")));
    const holderName = `ivat-lock-${path.basename(directory).toLowerCase()}`;
    let holder;
    t.after(async () => {
      spawnSync("docker", ["rm", "-f", holderName], { stdio: "ignore" });
      if (holder && holder.exitCode === null) await new Promise(resolve => holder.once("close", resolve));
      await rm(directory, { recursive: true, force: true });
    });
    const toolPath = `${implementation === "busybox" ? "/opt/ivat-busybox:" : ""}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
    const args = ["run", "--rm", "-e", `PATH=${toolPath}`, "-v", `${directory}:${directory}`, "-v", `${process.cwd()}:/source:ro`, "--entrypoint", "sh"];
    const prefix = 'set -eu; . /source/deploy/scripts/backup-lock.sh; ';
    const waitForFile = async name => {
      const deadline = Date.now() + 10000;
      for (;;) {
        try { await readFile(path.join(directory, name)); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
        assert.ok(Date.now() < deadline, `Timed out waiting for ${name}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    const heldScript = prefix + 'acquire_backup_lock "$1/lock" 5; touch "$1/held"; trap \'touch "$1/cleanup-started"; sleep 2; touch "$1/cleanup-finished"; exit 143\' TERM; while true; do sleep 0.1; done';
    holder = spawn("docker", [...args, "--name", holderName, "ivat-release155-operator:verify", "-c", heldScript, "sh", directory], { stdio: "ignore" });
    const holderExit = new Promise(resolve => holder.once("close", resolve));
    await waitForFile("held");
    const refused = spawnSync("docker", [...args, "ivat-release155-operator:verify", "-c", prefix + 'acquire_backup_lock "$1/lock" 1; touch "$1/should-not-enter"', "sh", directory], { encoding: "utf8", timeout: 10000 });
    assert.equal(refused.status, 1, refused.stderr);
    await assert.rejects(readFile(path.join(directory, "should-not-enter")), { code: "ENOENT" });
    const waiter = spawn("docker", [...args, "ivat-release155-operator:verify", "-c", prefix + 'touch "$1/waiting"; acquire_backup_lock "$1/lock" 8; touch "$1/entered"', "sh", directory], { stdio: "ignore" });
    const waiterExit = new Promise(resolve => waiter.once("close", resolve));
    await waitForFile("waiting");
    execFileSync("docker", ["kill", "--signal", "TERM", holderName], { stdio: "ignore" });
    await waitForFile("cleanup-started");
    await assert.rejects(readFile(path.join(directory, "entered")), { code: "ENOENT" });
    assert.equal(await holderExit, 143);
    await readFile(path.join(directory, "cleanup-finished"));
    assert.equal(await waiterExit, 0);
    await readFile(path.join(directory, "entered"));
  });
});

test("the daily workflow streams its lock helper to a legacy host with either tool implementation", async t => {
  execFileSync("docker", ["build", "-q", "-f", "deploy/tests/operator.Dockerfile", "-t", "ivat-release155-operator:verify", "."], { stdio: "pipe" });
  const workflow = await readFile(".github/workflows/daily-backup.yml", "utf8");
  const body = workflow.slice(workflow.indexOf("        run: |\n") + "        run: |\n".length).split("\n").map(line => line.replace(/^ {10}/, "")).join("\n");
  for (const implementation of ["gnu", "busybox"]) await t.test(implementation, async t => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ivat-daily-lock-")));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, "bin"));
    await mkdir(path.join(directory, "stack/deploy/scripts"), { recursive: true });
    await writeFile(path.join(directory, "bin/ssh"), '#!/bin/sh\nexec sh -s\n', { mode: 0o755 });
    await writeFile(path.join(directory, "workflow.sh"), body);
    const toolPath = `${directory}/bin:${implementation === "busybox" ? "/opt/ivat-busybox:" : ""}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
    const setup = 'mkdir -p /srv/stack/deploy/scripts; printf \'%s\\n\' \'#!/bin/sh\' \'set -eu\' \'test ! -e /srv/stack/deploy/scripts/backup-lock.sh\' \'if flock -n /tmp/ivat-backup.lock true; then exit 42; fi\' \'touch "$LOCK_TEST_DIRECTORY/daily-completed"\' > /srv/stack/deploy/scripts/backup-daily.sh; exec bash "$LOCK_TEST_DIRECTORY/workflow.sh"';
    const result = spawnSync("docker", ["run", "--rm", "--user", `${process.getuid()}:${process.getgid()}`, "-e", `PATH=${toolPath}`, "-e", `LOCK_TEST_DIRECTORY=${directory}`, "-e", "ROSTI_SSH_KEY=TEST_ONLY_KEY", "-e", "ROSTI_SSH_KNOWN_HOSTS=TEST_ONLY_HOST", "-e", "ROSTI_SSH_HOST=localhost", "-e", "ROSTI_SSH_PORT=22", "-e", "ROSTI_SSH_USER=root", "-e", `GITHUB_STEP_SUMMARY=${directory}/summary`, "-v", `${directory}:${directory}`, "-v", `${directory}/stack:/srv/stack`, "-v", `${process.cwd()}:/source:ro`, "-w", "/source", "ivat-release155-operator:verify", "-c", setup], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    await readFile(path.join(directory, "daily-completed"));
    assert.match(await readFile(path.join(directory, "summary"), "utf8"), /Daily backup completed/);
  });
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
