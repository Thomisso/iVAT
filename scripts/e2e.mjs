#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

let baseUrl = process.env.PLAYWRIGHT_BASE_URL;
const useProductionServer = process.env.E2E_PRODUCTION_SERVER === "1";
const environment = {
  ...process.env,
  AI_PROVIDER: "fake",
};
const managed = [];

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

function start(name, args) {
  const child = spawn(name, args, {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  managed.push(child);
  return child;
}

async function waitForApp(child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
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
    if (child.exitCode !== null) throw new Error(`${label} exited before it became available`);
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

function stopManagedProcesses() {
  for (const child of managed.reverse()) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    try {
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

async function main() {
  if (!baseUrl) {
    baseUrl = useProductionServer
      ? "http://127.0.0.1:3000"
      : `http://localhost:${await availablePort()}`;
  }
  environment.PLAYWRIGHT_BASE_URL = baseUrl;
  environment.APP_ORIGIN = new URL(baseUrl).origin;
  environment.AUTH_REDIRECT_ALLOWLIST = `${environment.APP_ORIGIN}/auth/callback`;
  environment.SUPABASE_E2E_REDIRECT_URL = `${environment.AUTH_REDIRECT_ALLOWLIST}?**`;
  const port = new URL(baseUrl).port;
  const aresPort = await availablePort();
  environment.ARES_BASE_URL = `http://127.0.0.1:${aresPort}/ares/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty`;
  console.log(`Running the acceptance stack at ${baseUrl}`);
  await command("npm", ["run", "db:stop", "--", "--no-backup"]);
  await command("npm", ["run", "db:start"]);
  const localStack = JSON.parse(execFileSync(
    process.execPath,
    ["scripts/supabase.mjs", "status", "-o", "json"],
    { cwd: process.cwd(), env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ));
  environment.MAILPIT_URL = localStack.MAILPIT_URL;
  if (useProductionServer) await command("npm", ["run", "build"]);

  const ares = start("postman", [
    "simulation", "run", "postman/simulations/ares/ares.sim.yaml",
    "--port", String(aresPort), "--no-history", "--output", "ndjson",
  ]);
  await waitForDependency(
    ares,
    `${environment.ARES_BASE_URL}/12345678`,
    "ARES simulation",
  );
  const web = start("npm", [
    "run",
    useProductionServer ? "start" : "dev",
    "--",
    "-p",
    port,
  ]);
  start(process.execPath, [
    "node_modules/tsx/dist/cli.mjs",
    "--env-file=.env.local",
    "worker/index.ts",
  ]);
  await waitForApp(web);
  await command("npx", ["playwright", "test", "--config=playwright.config.ts", ...process.argv.slice(2)]);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  stopManagedProcesses();
}
