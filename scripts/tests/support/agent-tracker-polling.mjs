// Exercise the real command/outbox with a controlled OS clock and GitHub
// boundary. No production clock hook or artificial successful receipt exists.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { publishRemote } from "./agent-tracker-state.mjs";

const planFile = new URL(import.meta.url).searchParams.get("plan");
const nativeRead = fs.readFileSync;
fs.readFileSync = (file, ...options) => {
  const value = nativeRead(file, ...options);
  if (file === process.env.TRACKER_FAKE_GITHUB && fs.existsSync(planFile) && process.argv.includes("repos/example/project/issues/99/comments?per_page=100&page=1")) {
    fs.appendFileSync(`${planFile}.reads`, `${Date.now()}\n`);
  }
  return value;
};
const nativeWait = Atomics.wait;
Atomics.wait = (...args) => {
  if (!fs.existsSync(planFile)) return nativeWait(...args);
  const plan = JSON.parse(nativeRead(planFile, "utf8"));
  const elapsed = Date.now() - plan.startedAt;
  const delay = args[3];
  fs.appendFileSync(`${planFile}.sleeps`, `${delay}\n`);
  fs.writeFileSync(process.env.TRACKER_CLOCK_FILE, new Date(Date.now() + delay).toISOString());
  if (!plan.completed && elapsed + delay >= plan.deliverAt) {
    plan.completed = true;
    fs.writeFileSync(planFile, JSON.stringify(plan));
    const remote = JSON.parse(nativeRead(process.env.TRACKER_FAKE_GITHUB, "utf8"));
    if (plan.mode === "failure") {
      remote.fail = "controlled network unavailable";
      publishRemote(process.env.TRACKER_FAKE_GITHUB, remote);
    } else {
      const worker = spawnSync(process.execPath, [process.env.TRACKER_COMMAND, "worker"], {
        encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_JOB: "publish", GITHUB_WORKFLOW_REF: "example/project/.github/workflows/agent-tracking.yml@refs/heads/main", GITHUB_ACTOR: "maintainer", TRACKER_EVENT: remote.dispatches.at(-1) },
      });
      if (worker.status !== 0 && plan.mode !== "rejected") throw new Error(worker.stderr);
    }
  }
  return "timed-out";
};
syncBuiltinESMExports();
