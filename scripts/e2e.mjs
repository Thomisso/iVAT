#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readSupabaseStatus } from "./supabase-status.mjs";

let baseUrl = process.env.IVAT_HTTP_BASE_URL;
const cliArguments = process.argv.slice(2);
const useDevelopmentServer = cliArguments.includes("--dev-server");
const unknownArguments = cliArguments.filter((argument) => argument !== "--dev-server");
const environment = {
  ...process.env,
  AI_PROVIDER: "fake",
  VAT_REGISTRY_PROVIDER: "fake",
  EXCHANGE_RATE_PROVIDER: "fake",
};
const managed = [];
let databaseOwned = false;
const serviceLogDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-e2e-"));
environment.IVAT_E2E_SERVICE_LOG_DIRECTORY = serviceLogDirectory;

async function phase(label, operation) {
  const startedAt = performance.now();
  console.log(`[e2e] ${label} started`);
  try {
    const result = await operation();
    console.log(`[e2e] ${label} completed in ${((performance.now() - startedAt) / 1_000).toFixed(1)}s`);
    return result;
  } catch (error) {
    console.error(`[e2e] ${label} failed after ${((performance.now() - startedAt) / 1_000).toFixed(1)}s`);
    throw error;
  }
}

function command(name, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(name, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

function start(name, args, label) {
  const logPath = path.join(serviceLogDirectory, `${label}.log`);
  const log = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn(name, args, {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.once("error", (error) => { child.launchError = error; });
  child.stdout.on("data", (chunk) => log.write(chunk));
  child.stderr.on("data", (chunk) => log.write(chunk));
  managed.push({ child, label, log, logPath });
  return child;
}

async function waitForApp(child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.launchError) throw child.launchError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Next.js exited before ${baseUrl} became available`);
    try {
      const response = await fetch(`${baseUrl}/login`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // The server is still starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${baseUrl}`);
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local port for Next.js"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForDependency(child, url, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.launchError) throw child.launchError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited before it became available`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The local stand-in is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function stopManagedProcesses() {
  for (const { child } of managed.toReversed()) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) continue;
    try {
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await Promise.all(managed.map(async ({ child, label }) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) { if (error?.code !== "ESRCH") throw error; }
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2_000)]);
      if (child.exitCode === null && child.signalCode === null) throw new Error(`Owned ${label} process did not stop`);
    }
  }));
  await Promise.all(managed.map(({ log }) => new Promise((resolve) => log.end(resolve))));
}

function preserveServiceLogs() {
  const destination = path.join(process.cwd(), "test-results", "service-logs");
  fs.mkdirSync(destination, { recursive: true });
  for (const { label, logPath } of managed) {
    const destinationPath = path.join(destination, `${label}.log`);
    fs.copyFileSync(logPath, destinationPath);
    const lines = fs.readFileSync(logPath, "utf8").trimEnd().split("\n");
    console.error(`\n[e2e] Last ${Math.min(lines.length, 40)} lines from ${label}:`);
    console.error(lines.slice(-40).join("\n"));
  }
  console.error(`\n[e2e] Complete service logs: ${path.relative(process.cwd(), destination)}`);
}

async function main() {
  // Refuse before touching a database or launching services. CI runners are
  // disposable clones; a local run must be in a linked, isolated worktree.
  if (unknownArguments.length) throw new Error("HTTP acceptance accepts only --dev-server; it never runs a browser suite");
  const gitDirectory = fs.realpathSync(execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim());
  const commonDirectory = fs.realpathSync(path.resolve(execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim()));
  if (gitDirectory === commonDirectory && !(process.env.GITHUB_ACTIONS === "true" && process.env.CI === "true")) {
    throw new Error("HTTP acceptance resets its disposable database; use a linked worktree, never the human checkout");
  }
  if (!baseUrl) baseUrl = `http://127.0.0.1:${await availablePort()}`;
  const target = new URL(baseUrl);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port || target.pathname !== "/" || target.search || target.hash || target.username || target.password) {
    throw new Error("IVAT_HTTP_BASE_URL must be an unused http://127.0.0.1:PORT origin");
  }
  // A bound port must fail before the destructive acceptance-stack reset.
  await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(Number(target.port), target.hostname, () => probe.close(error => error ? reject(error) : resolve()));
  });
  environment.IVAT_HTTP_BASE_URL = target.origin;
  environment.APP_ORIGIN = new URL(baseUrl).origin;
  environment.AUTH_REDIRECT_ALLOWLIST = `${environment.APP_ORIGIN}/auth/callback`;
  environment.SUPABASE_E2E_REDIRECT_URL = `${environment.APP_ORIGIN}/**`;
  const port = new URL(baseUrl).port;
  const aresPort = await availablePort();
  environment.ARES_BASE_URL = `http://127.0.0.1:${aresPort}/ares/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty`;
  console.log(`Running the acceptance stack at ${baseUrl}`);
  await phase("Stop existing database", () => command("npm", ["run", "db:stop", "--", "--no-backup"]));
  databaseOwned = true;
  await phase("Start acceptance database", () => command("npm", ["run", "db:start", "--", "--profile=e2e"]));
  const localStack = readSupabaseStatus({ env: environment });
  environment.MAILPIT_URL = localStack.MAILPIT_URL;
  const smtpPort = fs.readFileSync(".env.local", "utf8").match(/^SMTP_PORT=(\d+)$/m)?.[1];
  if (!smtpPort) throw new Error("Local invitation SMTP capture is not configured");
  Object.assign(environment, {
    SMTP_HOST: "127.0.0.1", SMTP_PORT: smtpPort, SMTP_LOCAL_CAPTURE: "true",
    SMTP_USER: "", SMTP_PASS: "", SMTP_ADMIN_EMAIL: "noreply@ivat.cz",
  });
  const readyFile = path.join(serviceLogDirectory, "transport-ready.json");
  const transport = start(process.execPath, ["node_modules/tsx/dist/cli.mjs", "acceptance/support/transport-server.ts", localStack.API_URL, readyFile], "supabase-transport");
  const transportDeadline = Date.now() + 15_000;
  while (!fs.existsSync(readyFile)) {
    if (transport.launchError) throw transport.launchError;
    if (transport.exitCode !== null || transport.signalCode !== null || Date.now() > transportDeadline) throw new Error("Local Auth HTTP transport did not start");
    await delay(100);
  }
  const routing = JSON.parse(fs.readFileSync(readyFile, "utf8"));
  environment.SUPABASE_INTERNAL_URL = routing.internalUrl;
  environment.IVAT_HTTP_TRANSPORT_CONTROL_URL = routing.controlUrl;
  if (!useDevelopmentServer) {
    await phase("Build production application", () => command("npm", ["run", "build"]));
  }

  await phase("Start acceptance services", async () => {
    const ares = start("postman", [
      "simulation", "run", "postman/simulations/ares/ares.sim.yaml",
      "--port", String(aresPort), "--no-history", "--output", "ndjson",
    ], "postman");
    await waitForDependency(
      ares,
      `${environment.ARES_BASE_URL}/12345678`,
      "ARES simulation",
    );
    const web = start("npm", [
      "run",
      useDevelopmentServer ? "dev" : "start",
      "--",
      "-p",
      port,
    ], "next");
    start(process.execPath, [
      "node_modules/tsx/dist/cli.mjs",
      "--env-file=.env.local",
      "worker/index.ts",
    ], "worker");
    await waitForApp(web);
  });
  await phase("Run production HTTP acceptance suite", () => command(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "--config=vitest.http.config.ts"],
  ));
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  try {
    await stopManagedProcesses();
    if (failed) preserveServiceLogs();
  } finally {
    if (databaseOwned) {
      try { await phase("Stop acceptance database", () => command("npm", ["run", "db:stop", "--", "--no-backup"])); }
      catch { process.exitCode = 1; }
    }
    fs.rmSync(serviceLogDirectory, { recursive: true, force: true });
  }
}
