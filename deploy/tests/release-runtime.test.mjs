import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { createReleaseBundle } from "../scripts/release-bundle.mjs";

const source = process.cwd();
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

test("the real release command guards and upgrades a disposable production stack", { skip: process.env.IVAT_RELEASE_RUNTIME_TEST !== "1", timeout: 1800000 }, async () => {
  await access("deploy/scripts/deploy-release.sh");
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ivat-release-runtime-")));
  const stack = path.join(directory, "stack");
  const project = "ivat-release155-check";
  const httpPort = await freePort(), apiPort = await freePort();
  let simulation;
  const common = ["compose", "--project-directory", stack, "--project-name", project, "--env-file", path.join(stack, ".env"), "-f", path.join(stack, "docker-compose.rosti.yml"), "-f", path.join(stack, "test-override.yml")];
  const operator = (script, args = [], env = {}) => command(["run", "--rm", "--entrypoint", "bash", "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", `${directory}:${directory}`, "-v", `${source}:${source}:ro`, ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]), "ivat-release155-operator:verify", script, ...args]);
  try {
    await mkdir(stack, { recursive: true });
    execFileSync(process.execPath, [path.join(source, "deploy/scripts/init.mjs"), path.join(stack, ".env")], { cwd: stack, stdio: "ignore" });
    await writeFile(path.join(stack, ".ivat-disposable-deployment"), "Test-only installation.\n");
    const env = parseEnv(await readFile(path.join(stack, ".env"), "utf8"));
    console.log("Build disposable operator and AMD64 application images.");
    docker("build", "-f", "deploy/tests/operator.Dockerfile", "-t", "ivat-release155-operator:verify", ".");
    docker("build", "--platform", "linux/amd64", "--build-arg", `NEXT_PUBLIC_SUPABASE_URL=${env.SUPABASE_PUBLIC_URL}`, "--build-arg", `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${env.ANON_KEY}`, "-t", "ivat-release155-app:verify", ".");
    await writeFile(path.join(directory, "probe.sql"), "create table public.ivat_release_probe (value text); insert into public.ivat_release_probe values ('upgrade-completed');\n");
    await writeFile(path.join(directory, "upgrade.Dockerfile"), "FROM ivat-release155-app:verify\nUSER root\nCOPY probe.sql /app/supabase/migrations/99999999990000_release_probe.sql\nUSER node\n");
    docker("build", "--platform", "linux/amd64", "-f", path.join(directory, "upgrade.Dockerfile"), "-t", "ivat-release155-upgrade:verify", directory);
    await writeFile(path.join(directory, "failure.sql"), "select this_migration_must_fail();\n");
    await writeFile(path.join(directory, "failure.Dockerfile"), "FROM ivat-release155-upgrade:verify\nUSER root\nCOPY failure.sql /app/supabase/migrations/99999999990001_release_failure.sql\nUSER node\n");
    docker("build", "--platform", "linux/amd64", "-f", path.join(directory, "failure.Dockerfile"), "-t", "ivat-release155-failure:verify", directory);
    const compose = JSON.parse(docker("compose", "-f", "docker-compose.rosti.yml", "config", "--no-interpolate", "--no-path-resolution", "--format", "json"));
    delete compose.name;
    const local = { app: "ivat-release155-app:verify", db: "ivat-release154-db:verify", gateway: "ivat-release154-gateway:verify", proxy: "ivat-release154-proxy:verify" };
    for (const [kind, services] of Object.entries({ app: ["web", "worker", "migrate", "backup"], db: ["db"], gateway: ["gateway"], proxy: ["proxy"] })) for (const service of services) { compose.services[service].image = local[kind]; delete compose.services[service].build; }
    Object.assign(compose.services.backup.volumes.find(volume => volume.target === "/backup-config/.env"), { type: "bind", source: "./.env", bind: { create_host_path: false } });
    delete compose.services.backup.volumes.find(volume => volume.target === "/backup-config/.env").volume;
    await writeFile(path.join(stack, "docker-compose.rosti.yml"), JSON.stringify(compose));
    await writeFile(path.join(stack, "docker-compose.yml"), JSON.stringify(compose));
    await cp("deploy/scripts", path.join(stack, "deploy/scripts"), { recursive: true });
    await cp("deploy/restore.yml", path.join(stack, "deploy/restore.yml"));
    const override = app => `services:\n  web:\n    image: ${app}\n  worker:\n    image: ${app}\n  migrate:\n    image: ${app}\n  backup:\n    image: ${app}\n  db:\n    image: ${local.db}\n  gateway:\n    image: ${local.gateway}\n  proxy:\n    image: ${local.proxy}\n    ports: !override\n      - \"127.0.0.1:${httpPort}:80\"\n  storage:\n    volumes: !override\n      - test-storage:/var/lib/storage\nvolumes:\n  test-storage:\n`;
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
    const targetCompose = JSON.parse(docker("compose", "-f", "docker-compose.rosti.yml", "config", "--no-interpolate", "--no-path-resolution", "--format", "json"));
    const bundle = path.join(directory, "bundle");
    const images = Object.fromEntries(["app", "db", "gateway", "proxy"].map(name => [name, `ghcr.io/thomisso/ivat/${name}@sha256:${"a".repeat(64)}`]));
    await createReleaseBundle({ sourceDirectory: source, outputDirectory: bundle, release: { repository: "thomisso/ivat", revision: "1".repeat(40), tag: "v0.2.0", releaseId: 155 }, publicBuild: { supabaseUrl: env.SUPABASE_PUBLIC_URL, publishableKey: env.ANON_KEY }, images, compose: targetCompose });
    await writeFile(path.join(stack, "test-override.yml"), override("ivat-release155-upgrade:verify"));
    simulation = spawn("postman", ["simulation", "run", "postman/simulations/rosti-deployment/rosti-deployment.sim.yaml", "--port", String(apiPort), "--no-history", "--output", "ndjson"], { stdio: ["ignore", "pipe", "pipe"] });
    let simulationLog = ""; simulation.stdout.on("data", chunk => { simulationLog += chunk; }); simulation.stderr.on("data", chunk => { simulationLog += chunk; });
    const deadline = Date.now() + 15000;
    while (!simulationLog.includes('"type":"listening"') && !simulationLog.includes('"event":"listening"')) { if (Date.now() > deadline) throw new Error("Simulation startup failed"); await new Promise(resolve => setTimeout(resolve, 100)); }
    const deployEnv = { IVAT_DEPLOY_TEST_APP_IMAGE: "ivat-release155-upgrade:verify", IVAT_DISPOSABLE_COMPOSE_OVERRIDE: path.join(stack, "test-override.yml"), IVAT_DEPLOY_LOCK_FILE: path.join(stack, "backup.lock"), IVAT_DEPLOY_LOCK_TIMEOUT: "1", ROSTI_API_URL: `http://host.docker.internal:${apiPort}/rosti/api-n`, ROSTI_API_KEY: "test-provider-secret", IVAT_DEPLOY_PUBLIC_URL: `http://host.docker.internal:${httpPort}/login` };
    const deploy = (selected = bundle, overrides = {}) => operator(path.join(bundle, "deploy/scripts/deploy-release.sh"), [stack, selected, project], { ...deployEnv, ...overrides });
    const webBefore = docker(...common, "ps", "-q", "web");
    for (const refusal of ["stale", "missing-inventory", "corrupt"]) {
      if (refusal === "stale") { const stale = new Date(Date.now() - 27 * 3600000); await utimes(archive, stale, stale); }
      if (refusal === "missing-inventory") await rm(archive + ".images.json");
      if (refusal === "corrupt") await writeFile(archive, "bad archive");
      const result = await deploy(); assert.notEqual(result.status, 0, refusal);
      assert.equal(docker(...common, "ps", "-q", "web"), webBefore);
      assert.equal(await readFile(path.join(stack, "deploy/release-commit.txt"), "utf8"), "0".repeat(40) + "\n");
      await writeFile(archive, archiveBytes); await writeFile(archive + ".images.json", inventoryBytes); await utimes(archive, new Date(), new Date());
    }
    const lock = spawn("docker", ["run", "--rm", "--entrypoint", "bash", "-v", `${directory}:${directory}`, "ivat-release155-operator:verify", "-c", `flock '${stack}/backup.lock' sh -c 'touch ${stack}/lock-ready; sleep 4'`]);
    while (true) { try { await access(path.join(stack, "lock-ready")); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
    assert.match((await deploy()).stderr, /lock/);
    await new Promise(resolve => lock.on("exit", resolve));
    console.log("Run successful upgrade through the actual command.");
    const success = await deploy(); assert.equal(success.status, 0, success.stderr + success.stdout);
    const verified = JSON.parse(await readFile(path.join(stack, "deploy/verified-release.json"), "utf8"));
    assert.equal(verified.revision, "1".repeat(40));
    assert.equal(docker(...common, "exec", "-T", "db", "psql", "-U", "postgres", "-Atc", "select value from public.ivat_retained_probe"), "retained-data");
    assert.equal(docker(...common, "exec", "-T", "db", "psql", "-U", "postgres", "-Atc", "select value from public.ivat_release_probe"), "upgrade-completed");
    assert.equal(docker("inspect", "--format", "{{.Image}}", docker(...common, "ps", "-q", "web")), docker("image", "inspect", "--format", "{{.Id}}", "ivat-release155-upgrade:verify"));
    assert.equal(await readFile(path.join(stack, ".env"), "utf8"), originalEnv);
    const failing = path.join(directory, "failing");
    await createReleaseBundle({ sourceDirectory: source, outputDirectory: failing, release: { repository: "thomisso/ivat", revision: "2".repeat(40), tag: "v0.3.0", releaseId: 156 }, publicBuild: { supabaseUrl: env.SUPABASE_PUBLIC_URL, publishableKey: env.ANON_KEY }, images, compose: targetCompose });
    await writeFile(path.join(stack, "test-override.yml"), override("ivat-release155-failure:verify"));
    console.log("Run a failing migration and verify manual recovery guard.");
    const failed = await deploy(failing, { IVAT_DEPLOY_TEST_APP_IMAGE: "ivat-release155-failure:verify" });
    assert.notEqual(failed.status, 0); assert.match(failed.stderr, /migration/);
    assert.equal(JSON.parse(await readFile(path.join(stack, "deploy/verified-release.json"), "utf8")).revision, verified.revision);
    assert.equal(docker(...common, "ps", "-q", "web"), "");
    await access(path.join(stack, "deploy/.deployment-unresolved"));
    const blockedBackup = await operator(path.join(stack, "deploy/scripts/backup.sh"), [path.join(stack, "deploy/backups")], { DEPLOY_ENV_FILE: ".env", DEPLOY_COMPOSE_OVERRIDE: path.join(stack, "test-override.yml"), COMPOSE_PROJECT_NAME: project });
    assert.notEqual(blockedBackup.status, 0); assert.match(blockedBackup.stderr, /unresolved deployment/);
    assert.equal(docker(...common, "ps", "-q", "web"), "");
    assert.match(simulationLog, /request/);
  } finally {
    simulation?.kill("SIGINT");
    try { docker(...common, "down", "--volumes", "--remove-orphans"); } catch { /* disposable cleanup only */ }
    if (process.env.IVAT_KEEP_RUNTIME_FIXTURE !== "1") await rm(directory, { recursive: true, force: true });
    else console.log("Retained disposable fixture: " + directory);
  }
});
