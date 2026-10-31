import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { createReleaseBundle, validateReleaseBundle } from "../scripts/release-bundle.mjs";
import { deployPreparedRelease } from "../scripts/connect-release.mjs";
import { waitForRequiredChecks } from "../scripts/prepare-release.mjs";
import { resolveReleaseRevision } from "../scripts/release-policy.mjs";
import { spawnSimulation } from "./simulation-process.mjs";
import { assertPublicApplicationAssets, requestPublicApplication } from "./public-application.mjs";

const checkout = process.cwd();
const probeMigration = "99999999990000_release_probe.sql";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }).trim();
async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function command(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn("docker", args, { env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("exit", status => resolve({ status, stdout, stderr }));
  });
}

async function requestCompiledLogin(endpoint) {
  const response = await requestPublicApplication(endpoint);
  return { status: response.status, body: response.bytes.toString("utf8") };
}

test("the compiled login request preserves application Host routing and response HTML", async () => {
  const html = "<html>Verze v0.2.0 · Revize 0123456789012345678901234567890123456789</html>";
  let received;
  const server = createHttpServer((request, response) => {
    received = { host: request.headers.host, forwardedProto: request.headers["x-forwarded-proto"], path: request.url };
    const accepted = received.host === "app.ivat.cz" && received.forwardedProto === "https" && received.path === "/login";
    response.writeHead(accepted ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(accepted ? html : "Unknown application Host");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.deepEqual(await requestCompiledLogin(`http://127.0.0.1:${server.address().port}/login`), { status: 200, body: html });
    assert.deepEqual(received, { host: "app.ivat.cz", forwardedProto: "https", path: "/login" });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

async function prepareRuntimeReleaseSource(source) {
  await mkdir(source);
  const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Release fixture");
  git("config", "user.email", "release@example.test");
  // Fetch the actual committed application tree, without copying credentials,
  // build output, or unrelated files from the working checkout.
  git("fetch", "--no-tags", checkout, "HEAD");
  git("reset", "--hard", "FETCH_HEAD");
  await writeFile(path.join(source, "supabase/migrations", probeMigration), "select pg_sleep(5); create table public.ivat_release_probe (value text); insert into public.ivat_release_probe values ('upgrade-completed');\n");
  git("add", `supabase/migrations/${probeMigration}`);
  git("commit", "-m", "Disposable release migration probe");
  const revision = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", revision);
  git("tag", "-a", "v0.2.0", "-m", "Disposable Release fixture");
  return { repository: "thomisso/ivat", revision, tag: "v0.2.0", releaseId: 155 };
}

test("the runtime release fixture tags the complete application source it builds", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "ivat-release-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const release = await prepareRuntimeReleaseSource(source);
  const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: "pipe" }).trim();
  assert.equal(resolveReleaseRevision(release.tag, release.revision, source), release.revision);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(await readFile(path.join(source, "src/application/epo-xml.ts"), "utf8"), await readFile(path.join(checkout, "src/application/epo-xml.ts"), "utf8"));
  assert.match(git("show", `${release.revision}:supabase/migrations/${probeMigration}`), /pg_sleep\(5\).*upgrade-completed/);
});

test("the real release command guards and upgrades a disposable production stack", { skip: process.env.IVAT_RELEASE_RUNTIME_TEST !== "1", timeout: 1800000 }, async () => {
  await access("deploy/scripts/deploy-release.sh");
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ivat-release-runtime-")));
  const source = path.join(directory, "release-source");
  const stack = path.join(directory, "stack");
  const project = "ivat-release155-check";
  const httpPort = await freePort(), apiPort = await freePort(), sshPort = await freePort();
  const sshContainer = "ivat-release156-ssh-check";
  let simulation;
  const common = ["compose", "--project-directory", stack, "--project-name", project, "--env-file", path.join(stack, ".env"), "-f", path.join(stack, "docker-compose.rosti.yml"), "-f", path.join(stack, "test-override.yml")];
  const operator = (script, args = [], env = {}) => command(["run", "--rm", "--entrypoint", "bash", "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", `${directory}:${directory}`, "-v", `${source}:${source}:ro`, ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]), "ivat-release155-operator:verify", script, ...args]);
  try {
    const release = await prepareRuntimeReleaseSource(source);
    const { revision } = release;
    await mkdir(stack, { recursive: true });
    execFileSync(process.execPath, [path.join(source, "deploy/scripts/init.mjs"), path.join(stack, ".env")], { cwd: stack, stdio: "ignore" });
    await writeFile(path.join(stack, ".ivat-disposable-deployment"), "Test-only installation.\n");
    const env = parseEnv(await readFile(path.join(stack, ".env"), "utf8"));
    console.log("Build disposable operator and AMD64 application images.");
    docker("build", "-f", path.join(source, "deploy/tests/operator.Dockerfile"), "-t", "ivat-release155-operator:verify", source);
    for (const name of ["db", "gateway", "proxy"]) docker("build", "--platform", "linux/amd64", "-t", `ivat-release155-${name}:verify`, path.join(source, "deploy", name));
    docker("build", "--platform", "linux/amd64", "--build-arg", `NEXT_PUBLIC_SUPABASE_URL=${env.SUPABASE_PUBLIC_URL}`, "--build-arg", `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${env.ANON_KEY}`, "--build-arg", `IVAT_RELEASE_TAG=${release.tag}`, "--build-arg", `IVAT_RELEASE_REVISION=${revision}`, "-t", "ivat-release155-upgrade:verify", source);
    // Synthetic baseline only: omit the new migration to leave real upgrade
    // work pending. The versioned target image above is the committed tree.
    await writeFile(path.join(directory, "baseline.Dockerfile"), `FROM ivat-release155-upgrade:verify\nUSER root\nRUN rm /app/supabase/migrations/${probeMigration}\nUSER node\n`);
    docker("build", "--platform", "linux/amd64", "-f", path.join(directory, "baseline.Dockerfile"), "-t", "ivat-release155-app:verify", directory);
    await writeFile(path.join(directory, "failure.sql"), "select this_migration_must_fail();\n");
    await writeFile(path.join(directory, "failure.Dockerfile"), "FROM ivat-release155-upgrade:verify\nUSER root\nCOPY failure.sql /app/supabase/migrations/99999999990001_release_failure.sql\nUSER node\n");
    docker("build", "--platform", "linux/amd64", "-f", path.join(directory, "failure.Dockerfile"), "-t", "ivat-release155-failure:verify", directory);
    const compose = JSON.parse(docker("compose", "-f", path.join(source, "docker-compose.rosti.yml"), "config", "--no-interpolate", "--no-path-resolution", "--format", "json"));
    delete compose.name;
    const local = { app: "ivat-release155-app:verify", db: "ivat-release155-db:verify", gateway: "ivat-release155-gateway:verify", proxy: "ivat-release155-proxy:verify" };
    for (const [kind, services] of Object.entries({ app: ["web", "worker", "migrate", "backup"], db: ["db"], gateway: ["gateway"], proxy: ["proxy"] })) for (const service of services) { compose.services[service].image = local[kind]; delete compose.services[service].build; }
    Object.assign(compose.services.backup.volumes.find(volume => volume.target === "/backup-config/.env"), { type: "bind", source: "./.env", bind: { create_host_path: false } });
    delete compose.services.backup.volumes.find(volume => volume.target === "/backup-config/.env").volume;
    await writeFile(path.join(stack, "docker-compose.rosti.yml"), JSON.stringify(compose));
    await writeFile(path.join(stack, "docker-compose.yml"), JSON.stringify(compose));
    await cp(path.join(source, "deploy/scripts"), path.join(stack, "deploy/scripts"), { recursive: true });
    await cp(path.join(source, "deploy/restore.yml"), path.join(stack, "deploy/restore.yml"));
    const override = app => `services:\n  web:\n    image: ${app}\n    healthcheck:\n      interval: 2s\n      start_period: 0s\n  worker:\n    image: ${app}\n    healthcheck:\n      interval: 2s\n      start_period: 0s\n  migrate:\n    image: ${app}\n  backup:\n    image: ${app}\n  db:\n    image: ${local.db}\n  gateway:\n    image: ${local.gateway}\n  proxy:\n    image: ${local.proxy}\n    healthcheck:\n      interval: 2s\n    ports: !override\n      - \"127.0.0.1:${httpPort}:80\"\n  storage:\n    volumes: !override\n      - test-storage:/var/lib/storage\nvolumes:\n  test-storage:\n`;
    await writeFile(path.join(stack, "test-override.yml"), override(local.app));
    console.log("Boot baseline production services.");
    docker(...common, "up", "-d", "--no-build", "--wait", "--wait-timeout", "240");
    docker(...common, "exec", "-T", "db", "psql", "-U", "postgres", "-c", "create table public.ivat_retained_probe (value text); insert into public.ivat_retained_probe values ('retained-data');");
    await writeFile(path.join(stack, "deploy/release-commit.txt"), "0".repeat(40) + "\n");
    console.log("Create disposable daily backup fixture.");
    const backup = await operator(path.join(stack, "deploy/scripts/backup.sh"), [path.join(stack, "deploy/backups")], { DEPLOY_ENV_FILE: ".env", DEPLOY_COMPOSE_OVERRIDE: path.join(stack, "test-override.yml"), COMPOSE_PROJECT_NAME: project });
    assert.equal(backup.status, 0, backup.stderr);
    const { readdir } = await import("node:fs/promises");
    const archive = path.join(stack, "deploy/backups", (await readdir(path.join(stack, "deploy/backups"))).find(name => name.endsWith(".tar.gz")));
    const archiveBytes = await readFile(archive), inventoryBytes = await readFile(archive + ".images.json");
    const originalEnv = await readFile(path.join(stack, ".env"), "utf8");
    const targetCompose = JSON.parse(docker("compose", "-f", path.join(source, "docker-compose.rosti.yml"), "config", "--no-interpolate", "--no-path-resolution", "--format", "json"));
    const bundle = path.join(directory, "bundle");
    const images = Object.fromEntries(["app", "db", "gateway", "proxy"].map(name => [name, `ghcr.io/thomisso/ivat/${name}@sha256:${"a".repeat(64)}`]));
    const event = { action: "published", repository: { full_name: "Thomisso/iVAT" }, release: { id: 155, tag_name: "v0.2.0", draft: false, prerelease: false } };
    assert.equal(resolveReleaseRevision(release.tag, revision, source), revision);
    await createReleaseBundle({ sourceDirectory: source, outputDirectory: bundle, release, publicBuild: { supabaseUrl: env.SUPABASE_PUBLIC_URL, publishableKey: env.ANON_KEY }, images, compose: targetCompose });
    const manifest = await validateReleaseBundle(bundle);
    const releaseArchive = path.join(directory, "release.tar.gz");
    execFileSync("tar", ["--format", "ustar", "-czf", releaseArchive, "-C", bundle, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    await writeFile(path.join(stack, "test-override.yml"), override("ivat-release155-upgrade:verify"));
    simulation = spawnSimulation("postman/simulations/release-flow/release-flow.sim.yaml", apiPort);
    let simulationLog = ""; simulation.child.stdout.on("data", chunk => { simulationLog += chunk; }); simulation.child.stderr.on("data", chunk => { simulationLog += chunk; });
    const deadline = Date.now() + 15000;
    while (!simulationLog.includes('"type":"listening"') && !simulationLog.includes('"event":"listening"')) { if (Date.now() > deadline) throw new Error("Simulation startup failed"); await new Promise(resolve => setTimeout(resolve, 100)); }
    const deployEnv = { IVAT_DEPLOY_TEST_APP_IMAGE: "ivat-release155-upgrade:verify", IVAT_DISPOSABLE_COMPOSE_OVERRIDE: path.join(stack, "test-override.yml"), IVAT_DEPLOY_LOCK_FILE: path.join(stack, "backup.lock"), IVAT_DEPLOY_LOCK_TIMEOUT: "1", ROSTI_API_URL: `http://host.docker.internal:${apiPort}/rosti/api-n`, ROSTI_API_KEY: "test-provider-secret", IVAT_DEPLOY_PUBLIC_URL: `http://host.docker.internal:${httpPort}/login` };
    const deploy = (selected = bundle, overrides = {}) => operator(path.join(bundle, "deploy/scripts/deploy-release.sh"), [stack, selected, project], { ...deployEnv, ...overrides });
    console.log("Connect through real pinned SSH into the disposable host.");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(directory, "client")]);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(directory, "host")]);
    await writeFile(path.join(directory, "sshd-environment"), Object.entries(deployEnv).filter(([name]) => name !== "ROSTI_API_KEY").map(([name, value]) => `${name}=${value}`).join("\n") + "\n");
    docker("run", "-d", "--name", sshContainer, "--entrypoint", "sh", "-p", `127.0.0.1:${sshPort}:22`, "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", `${directory}:${directory}`, "ivat-release155-operator:verify", "-c", `mkdir -p /root/.ssh /run/sshd; chmod 700 /root/.ssh; cp '${directory}/client.pub' /root/.ssh/authorized_keys; cp '${directory}/sshd-environment' /root/.ssh/environment; chmod 600 /root/.ssh/*; exec /usr/sbin/sshd -D -e -h '${directory}/host' -o PermitRootLogin=prohibit-password -o PasswordAuthentication=no -o PermitUserEnvironment=yes`);
    const hostKey = (await readFile(path.join(directory, "host.pub"), "utf8")).trim();
    const sshDeadline = Date.now() + 15000;
    while (!await new Promise(resolve => {
      const socket = createConnection({ host: "127.0.0.1", port: sshPort });
      socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => { socket.destroy(); resolve(false); });
    })) { if (Date.now() > sshDeadline) throw new Error("Disposable SSH host did not start."); await new Promise(resolve => setTimeout(resolve, 50)); }
    const connection = { archive: await readFile(releaseArchive), verified: release, event, stack, project, actor: "release-fixture", ssh: { host: "127.0.0.1", port: sshPort, user: "root", privateKey: await readFile(path.join(directory, "client"), "utf8"), knownHosts: `[127.0.0.1]:${sshPort} ${hostKey}` }, pollMs: 50, timeoutMs: 600000 };
    process.env.GHCR_TOKEN = "test-registry-secret"; process.env.ROSTI_API_KEY = "test-provider-secret";
    const checks = { repository: release.repository, revision, token: "test-github-secret", apiUrl: `http://127.0.0.1:${apiPort}/github`, timeoutMs: 1000, pollMs: 20 };
    const controlGithub = behavior => fetch(`${checks.apiUrl}/__control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ behavior, revision }) });
    const webBefore = docker(...common, "ps", "-q", "web");
    const configurationBefore = await readFile(path.join(stack, "docker-compose.rosti.yml"), "utf8");
    await assert.rejects(deployPreparedRelease({ ...connection, ssh: { ...connection.ssh, knownHosts: `untrusted.example ${hostKey}` }, attemptId: "github-untrusted-host" }), /SSH transport failed/);
    await assert.rejects(access(path.join(stack, "deploy/incoming/github-untrusted-host")));
    await controlGithub("failed");
    await assert.rejects(async () => { await waitForRequiredChecks(checks); await deployPreparedRelease({ ...connection, attemptId: "github-blocked-checks" }); }, /did not succeed/);
    await assert.rejects(access(path.join(stack, "deploy/incoming/github-blocked-checks")));
    assert.equal(docker(...common, "ps", "-q", "web"), webBefore);
    await controlGithub("eventually-success"); await waitForRequiredChecks(checks);
    await rm(archive);
    await assert.rejects(deployPreparedRelease({ ...connection, attemptId: "github-blocked-backup" }), /failed at preflight/);
    assert.equal((await readFile(path.join(stack, "deploy/transports/github-blocked-backup/result"), "utf8")).trim(), "failed");
    assert.equal(docker(...common, "ps", "-q", "web"), webBefore);
    await writeFile(archive, archiveBytes);
    for (const refusal of ["stale", "missing-archive", "missing-inventory", "corrupt"]) {
      if (refusal === "stale") { const stale = new Date(Date.now() - 27 * 3600000); await utimes(archive, stale, stale); }
      if (refusal === "missing-archive") await rm(archive);
      if (refusal === "missing-inventory") await rm(archive + ".images.json");
      if (refusal === "corrupt") await writeFile(archive, "bad archive");
      const result = await deploy(); assert.notEqual(result.status, 0, refusal);
      assert.equal(docker(...common, "ps", "-q", "web"), webBefore);
      assert.equal(await readFile(path.join(stack, "docker-compose.rosti.yml"), "utf8"), configurationBefore);
      assert.equal(await readFile(path.join(stack, ".env"), "utf8"), originalEnv);
      assert.equal(await readFile(path.join(stack, "deploy/release-commit.txt"), "utf8"), "0".repeat(40) + "\n");
      await writeFile(archive, archiveBytes); await writeFile(archive + ".images.json", inventoryBytes); await utimes(archive, new Date(), new Date());
    }
    const bin = path.join(directory, "failure-bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "docker"), `#!/bin/sh
case " $* " in
  *" images -q "*) [ "$IVAT_TEST_DOCKER_FAILURE" != retention ] || exit 42;;
  *" selected-images "*) [ "$IVAT_TEST_DOCKER_FAILURE" != selected-images ] || exit 42;;
esac
exec /usr/local/bin/docker "$@"
`);
    await chmod(path.join(bin, "docker"), 0o755);
    const failureEnv = { PATH: `${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` };
    const retentionRefused = await deploy(bundle, { ...failureEnv, IVAT_TEST_DOCKER_FAILURE: "retention" });
    assert.notEqual(retentionRefused.status, 0);
    assert.match(retentionRefused.stderr, /at retain/);
    assert.equal(docker(...common, "ps", "-q", "web"), webBefore);
    await assert.rejects(access(path.join(stack, "deploy/.deployment-unresolved")));
    const lock = spawn("docker", ["run", "--rm", "--entrypoint", "bash", "-v", `${directory}:${directory}`, "ivat-release155-operator:verify", "-c", `flock '${stack}/backup.lock' sh -c 'touch ${stack}/lock-ready; sleep 4'`]);
    while (true) { try { await access(path.join(stack, "lock-ready")); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
    assert.match((await deploy()).stderr, /lock/);
    await new Promise(resolve => lock.on("exit", resolve));
    console.log("Kill the runner observer during real migration; host must finish with its lock intact.");
    const connectFixture = path.join(directory, "connection.json");
    // Disposable test credentials only; never a production configuration.
    await writeFile(connectFixture, JSON.stringify({ ...connection, archive: undefined, attemptId: "github-disconnect" }), { mode: 0o600 });
    const observer = spawn(process.execPath, ["--input-type=module", "-e", 'import {readFile} from "node:fs/promises"; import {deployPreparedRelease} from "./deploy/scripts/connect-release.mjs"; const connection=JSON.parse(await readFile(process.argv[1],"utf8")); connection.archive=await readFile(process.argv[2]); await deployPreparedRelease(connection);', connectFixture, releaseArchive], { stdio: ["ignore", "pipe", "pipe"] });
    let observerErrors = ""; observer.stderr.on("data", bytes => { observerErrors += bytes; });
    try {
      const deadline = Date.now() + 60000;
      while (true) {
        let phase; try { phase = (await readFile(path.join(stack, "deploy/attempts/github-disconnect/phase"), "utf8")).trim(); } catch { /* not launched yet */ }
        if (phase === "migration" && docker(...common, "ps", "--status", "running", "-q", "migrate")) break;
        if (Date.now() > deadline || observer.exitCode !== null) throw new Error("Observer never reached running migration: " + observerErrors);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      observer.kill("SIGKILL");
      await access(path.join(stack, "deploy/.deployment-unresolved"));
      const refused = await operator("-c", [`flock -n '${stack}/backup.lock' true`]);
      assert.notEqual(refused.status, 0, "runner loss must not release the host deployment lock");
      const completionDeadline = Date.now() + 60000;
      while ((await readFile(path.join(stack, "deploy/transports/github-disconnect/result"), "utf8")).trim() === "running") {
        if (Date.now() > completionDeadline) throw new Error("Detached host did not reach a durable result.");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal((await readFile(path.join(stack, "deploy/transports/github-disconnect/result"), "utf8")).trim(), "success");
      assert.equal(JSON.parse(await readFile(path.join(stack, "deploy/verified-release.json"), "utf8")).attempt, "deploy/attempts/github-disconnect");
    } finally { observer.kill("SIGKILL"); await rm(connectFixture); }
    console.log("Inject selected-image producer failure after a real upgrade.");
    const inspectionFailed = await deploy(bundle, { ...failureEnv, IVAT_TEST_DOCKER_FAILURE: "selected-images" });
    assert.notEqual(inspectionFailed.status, 0);
    assert.match(inspectionFailed.stderr, /at verification/);
    assert.equal(JSON.parse(await readFile(path.join(stack, "deploy/verified-release.json"), "utf8")).attempt, "deploy/attempts/github-disconnect");
    assert.equal(await readFile(path.join(stack, "deploy/release-commit.txt"), "utf8"), revision + "\n");
    assert.equal(docker("inspect", "--format", "{{.State.Running}}", docker(...common, "ps", "-aq", "migrate")), "false");
    // Explicit test-only acknowledgment after confirming migration is stopped.
    await rm(path.join(stack, "deploy/.deployment-unresolved"));
    console.log("Run successful upgrade through the actual command.");
    const success = await deployPreparedRelease({ ...connection, attemptId: "github-success" });
    assert.equal(success.revision, revision);
    const verified = JSON.parse(await readFile(path.join(stack, "deploy/verified-release.json"), "utf8"));
    assert.equal(verified.revision, revision);
    const runtimeIdentity = JSON.parse(docker(...common, "exec", "-T", "web", "node_modules/.bin/tsx", "-e", 'import{releaseIdentity,xmlGeneratorVersion}from"./src/lib/release-identity";console.log(JSON.stringify({releaseIdentity,xmlGeneratorVersion}))'));
    assert.deepEqual(runtimeIdentity, {
      releaseIdentity: { tag: manifest.tag, revision: manifest.revision },
      xmlGeneratorVersion: `${manifest.tag}+${manifest.revision}`,
    });
    const login = await requestCompiledLogin(`http://127.0.0.1:${httpPort}/login`);
    assert.equal(login.status, 200);
    const loginHtml = login.body;
    assert.ok(loginHtml.includes(`Verze ${manifest.tag}`), "compiled login must identify the validated release tag");
    assert.ok(loginHtml.includes(`Revize ${manifest.revision}`), "compiled login must identify the validated release revision");
    await assertPublicApplicationAssets(`http://127.0.0.1:${httpPort}`, source);
    const repeated = await deploy(bundle, { IVAT_DEPLOY_ATTEMPT_ID: path.basename(verified.attempt) });
    assert.notEqual(repeated.status, 0);
    assert.equal((await readFile(path.join(stack, verified.attempt, "result"), "utf8")).trim(), "success");
    assert.equal(docker(...common, "exec", "-T", "db", "psql", "-U", "postgres", "-Atc", "select value from public.ivat_retained_probe"), "retained-data");
    assert.equal(docker(...common, "exec", "-T", "db", "psql", "-U", "postgres", "-Atc", "select value from public.ivat_release_probe"), "upgrade-completed");
    assert.equal(docker("inspect", "--format", "{{.Image}}", docker(...common, "ps", "-q", "web")), docker("image", "inspect", "--format", "{{.Id}}", "ivat-release155-upgrade:verify"));
    assert.equal(await readFile(path.join(stack, ".env"), "utf8"), originalEnv);
    const failing = path.join(directory, "failing");
    // Inject a bad migration through the disposable-only image override. It is
    // deliberately not represented as a different successfully built release.
    await createReleaseBundle({ sourceDirectory: source, outputDirectory: failing, release, publicBuild: { supabaseUrl: env.SUPABASE_PUBLIC_URL, publishableKey: env.ANON_KEY }, images, compose: targetCompose });
    await writeFile(path.join(stack, "test-override.yml"), override("ivat-release155-failure:verify"));
    console.log("Run a failing migration and verify manual recovery guard.");
    const failed = await deploy(failing, { IVAT_DEPLOY_TEST_APP_IMAGE: "ivat-release155-failure:verify" });
    assert.notEqual(failed.status, 0); assert.match(failed.stderr, /migration/);
    assert.deepEqual(JSON.parse(await readFile(path.join(stack, "deploy/verified-release.json"), "utf8")), verified);
    assert.equal(docker(...common, "ps", "-q", "web"), "");
    await access(path.join(stack, "deploy/.deployment-unresolved"));
    const blockedBackup = await operator(path.join(stack, "deploy/scripts/backup.sh"), [path.join(stack, "deploy/backups")], { DEPLOY_ENV_FILE: ".env", DEPLOY_COMPOSE_OVERRIDE: path.join(stack, "test-override.yml"), COMPOSE_PROJECT_NAME: project });
    assert.notEqual(blockedBackup.status, 0); assert.match(blockedBackup.stderr, /unresolved deployment/);
    assert.equal(docker(...common, "ps", "-q", "web"), "");
    assert.match(simulationLog, /request/);
    assert.match(simulationLog, /ci\.yml/); assert.match(simulationLog, /deployment-check\.yml/);
  } finally {
    try { await simulation?.stop(); }
    finally {
      try { docker("rm", "-f", sshContainer); } catch { /* disposable cleanup only */ }
      try { docker(...common, "down", "--volumes", "--remove-orphans"); } catch { /* disposable cleanup only */ }
      if (process.env.IVAT_KEEP_RUNTIME_FIXTURE !== "1") await rm(directory, { recursive: true, force: true });
      else console.log("Retained disposable fixture: " + directory);
    }
  }
});
