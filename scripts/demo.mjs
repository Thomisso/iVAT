#!/usr/bin/env node
// Starts the app with demo data in one command: the local Supabase stack, the
// Next.js dev server on a free port, the worker, and a fresh seeded account
// (scripts/dev-seed.ts). Prints the URL and the account's sign-in details, then
// keeps the servers running until Ctrl+C. The Supabase stack stays up; stop it
// with `npm run db:stop`.
//
//   npm run demo
//
// The servers' output goes to .demo/next.log and .demo/worker.log.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const logDir = path.join(root, ".demo");
const children = [];

function fail(message) {
  console.error(`demo: ${message}`);
  stopChildren();
  process.exit(1);
}

function run(script, args = []) {
  const { status, stdout, stderr } = spawnSync("npm", ["run", "--silent", script, "--", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (status !== 0) fail(`npm run ${script} failed:\n${stderr}${stdout}`);
  return stdout;
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

async function freePort(from) {
  for (let port = from; port < from + 100; port++) if (await portIsFree(port)) return port;
  fail(`no free port in ${from}–${from + 99}`);
}

/** Starts a long-running npm script, logs it to .demo/<name>.log, and resolves with the first log match of `ready`. */
function startServer(name, script, args, ready) {
  const logFile = path.join(logDir, `${name}.log`);
  const log = fs.createWriteStream(logFile);
  // Its own process group, so stopping it also stops the processes npm spawns.
  const child = spawn("npm", ["run", "--silent", script, "--", ...args], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve) => {
    let output = "";
    const onData = (chunk) => {
      log.write(chunk);
      output += chunk.toString().replace(/\x1b\[[0-9;]*m/g, "");
      const match = output.match(ready);
      if (match) {
        output = "";
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        child.stdout.on("data", (more) => log.write(more));
        child.stderr.on("data", (more) => log.write(more));
        resolve(match);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => fail(`${name} exited with code ${code}; see ${path.relative(root, logFile)}`));
  });
}

function stopChildren() {
  for (const child of children) {
    child.removeAllListeners("exit");
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

async function main() {
  fs.mkdirSync(logDir, { recursive: true });

  console.log("Starting Supabase…");
  run("db:start");
  // A stack that was already running skips migrations added since it started.
  run("db:migrate");

  console.log("Starting the dev server and the worker…");
  const port = await freePort(3000);
  const [[, appUrl]] = await Promise.all([
    startServer("next", "dev", ["-p", String(port)], /Local:\s+(\S+)[\s\S]*Ready/),
    startServer("worker", "worker", [], /waiting for jobs/),
  ]);

  console.log("Seeding a demo account…");
  const seed = run("dev:seed", ["--base-url", appUrl]);
  const field = (label) => seed.match(new RegExp(`^${label}:\\s+(\\S+)`, "m"))?.[1];

  // Compile the sign-in page now, so the first visit doesn't wait for it.
  await fetch(`${appUrl}/login`).catch(() => {});

  console.log(`
URL:       ${appUrl}/login
Login:     ${field("Email")}
Password:  ${field("Password")}

Company:   ${field("Company")}
Logs:      .demo/next.log, .demo/worker.log
Press Ctrl+C to stop the dev server and the worker (Supabase keeps running; npm run db:stop stops it).`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopChildren();
    process.exit(0);
  });
}

main().catch((error) => fail(error.stack ?? String(error)));
