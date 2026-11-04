import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const command = new URL("../agent-tracker.mjs", import.meta.url).pathname;

function repository(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ivat-tracker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=Tracker test", "-c", "user.email=tracker@example.test", "commit", "--allow-empty", "-m", "Fixture"], { cwd: directory, stdio: "pipe" });
  execFileSync("git", ["branch", "feat/ticket"], { cwd: directory, stdio: "pipe" });
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  copyFileSync(new URL("support/agent-tracker-gh.mjs", import.meta.url), path.join(bin, "gh"));
  chmodSync(path.join(bin, "gh"), 0o755);
  const remote = path.join(directory, "github.json");
  writeFileSync(remote, JSON.stringify({ project: { id: "PVT_test", title: "Agent work", url: "https://github.com/users/example/projects/1" }, fields: [{ id: "status", name: "Status", dataType: "SINGLE_SELECT", options: [] }] }));
  return {
    directory,
    remote: () => JSON.parse(readFileSync(remote, "utf8")),
    updateRemote: update => { const state = JSON.parse(readFileSync(remote, "utf8")); update(state); writeFileSync(remote, JSON.stringify(state)); },
    run: (...args) => spawnSync(process.execPath, [command, ...args], { cwd: directory, encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TRACKER_FAKE_GITHUB: remote, TRACKER_COMMAND: command } }),
  };
}

test("tracker refuses missing configuration without claiming successful setup", t => {
  const repo = repository(t);
  const result = repo.run("doctor");
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, "configuration_missing");
});

test("failed publication remains durably pending and later sync preserves the original claim time", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  assert.equal(repo.run("start", "--run", "recoverable-run").status, 0);
  repo.updateRemote(state => { state.fail = "network unavailable"; });
  const claim = repo.run("claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket", "--at", "2026-11-04T12:00:00.000Z", "--wait-seconds", "0");
  assert.equal(claim.status, 1);
  assert.equal(JSON.parse(claim.stderr).error, "publication_pending");
  repo.updateRemote(state => { delete state.fail; });
  assert.equal(JSON.parse(repo.run("show").stdout).local.pending.length, 1);
  const synchronized = repo.run("sync");
  assert.equal(synchronized.status, 0, synchronized.stderr);
  const shown = JSON.parse(repo.run("show").stdout);
  assert.equal(shown.local.pending.length, 0);
  assert.equal(shown.remote.tickets[201].stateAt, "2026-11-04T12:00:00.000Z");
});

test("claim refuses a nonexistent local branch before creating implementation evidence", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  assert.equal(repo.run("start", "--run", "owned-run").status, 0);
  const result = repo.run("claim", "--issue", "201", "--agent", "worker", "--branch", "invented-branch");
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, "branch_missing");
});

test("one owner claims a ticket through a serialized worker and repeated sync keeps one item/comment", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  const start = repo.run("start", "--run", "run-first");
  assert.equal(start.status, 0, start.stderr);
  const claim = repo.run("claim", "--issue", "201", "--agent", "implementer-one", "--branch", "feat/ticket", "--result", "Implementation started");
  assert.equal(claim.status, 0, claim.stderr);
  const record = JSON.parse(repo.run("show").stdout).remote.tickets["201"];
  assert.equal(record.agent, "implementer-one");
  assert.equal(record.account, "maintainer");
  assert.equal(record.status, "implementing");
  assert.equal(record.activity, "unverified");
  assert.equal(record.activityAt, null);
  const offlineRecord = JSON.parse(repo.run("show", "--local").stdout).local.lastConfirmed.tickets["201"];
  assert.equal(offlineRecord.branch, "feat/ticket");
  assert.equal(repo.run("sync").status, 0);
  assert.equal(Object.keys(repo.remote().items).length, 1);
  assert.equal(repo.remote().ticketComments.length, 1);
  const second = repo.run("start", "--run", "run-second");
  assert.equal(second.status, 1);
  assert.equal(JSON.parse(second.stderr).error, "run_already_owned");
});

test("setup selects a real project and repeats without duplicate fields or registry comments", t => {
  const repo = repository(t);
  const setup = () => repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99");
  const firstSetup = setup();
  assert.equal(firstSetup.status, 0, firstSetup.stderr);
  const first = repo.remote();
  assert.ok(first.fields.find(field => field.name === "Status").options.some(option => option.name === "Implementace"));
  assert.equal(setup().status, 0);
  assert.equal(repo.remote().fields.length, first.fields.length);
  assert.equal(repo.remote().registry, first.registry);
  assert.equal(JSON.parse(repo.run("doctor").stdout).ok, true);
});

test("setup refuses competing native workflows unless their removal is explicit", t => {
  const repo = repository(t);
  repo.updateRemote(state => { state.workflows = [{ id: "WF_done", name: "Item closed", enabled: true }]; });
  const args = ["setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99"];
  const refused = repo.run(...args);
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stderr).error, "native_workflows_enabled");
  assert.equal(repo.remote().workflows.length, 1);
  const accepted = repo.run(...args, "--disable-native-workflows");
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(repo.remote().workflows.length, 0);
});

test("permission refusal remains distinct from a transient connection failure and does not leak credentials", t => {
  const repo = repository(t);
  const args = ["setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99"];
  repo.updateRemote(state => { state.fail = "missing required scope project; gho_secret_must_not_escape"; });
  const denied = repo.run(...args);
  assert.equal(JSON.parse(denied.stderr).error, "github_permission_denied");
  assert.ok(!denied.stderr.includes("gho_secret"));
  repo.updateRemote(state => { state.fail = "connection unavailable"; });
  assert.equal(JSON.parse(repo.run(...args).stderr).error, "github_connection_failed");
});

test("linked worktrees observe the same owning run and cannot start an independent controller", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  assert.equal(repo.run("start", "--run", "shared-owner").status, 0);
  const linked = path.join(repo.directory, "linked");
  execFileSync("git", ["worktree", "add", linked, "-b", "linked"], { cwd: repo.directory, stdio: "pipe" });
  const config = path.join(repo.directory, ".github/agent-tracking.json");
  const env = { ...process.env, PATH: `${path.join(repo.directory, "bin")}${path.delimiter}${process.env.PATH}`, TRACKER_FAKE_GITHUB: path.join(repo.directory, "github.json"), TRACKER_COMMAND: command };
  const shown = spawnSync(process.execPath, [command, "show", "--config", config], { cwd: linked, env, encoding: "utf8" });
  assert.equal(JSON.parse(shown.stdout).local.run.runId, "shared-owner");
  const second = spawnSync(process.execPath, [command, "start", "--run", "second-owner", "--config", config], { cwd: linked, env, encoding: "utf8" });
  assert.equal(JSON.parse(second.stderr).error, "run_already_owned");
});

test("doctor refuses incomplete field configuration instead of declaring setup valid", t => {
  const repo = repository(t);
  assert.equal(repo.run("setup", "--repo", "example/project", "--owner", "example", "--project-number", "1", "--registry-issue", "99").status, 0);
  const file = path.join(repo.directory, ".github/agent-tracking.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  delete config.fields.agent;
  writeFileSync(file, JSON.stringify(config));
  const refused = repo.run("doctor");
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stderr).error, "configuration_invalid");
});
