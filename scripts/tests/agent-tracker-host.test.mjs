import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { trackerFixture, resultJson } from "./support/agent-tracker-fixture.mjs";

function hostFixture(t, identity = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-tracker-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsFile = path.join(root, "identity.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ hostname: "Kernel-Mac", platform: "darwin", localHostName: "Studio-Mac\n", ...identity }));
  const preload = new URL("./support/agent-tracker-host.mjs", import.meta.url);
  preload.searchParams.set("fixture", settingsFile);
  const repo = trackerFixture(t, { nodeImports: [preload.href], captureOutput: true });
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("start", "--run", "host-recovery").status, 0);
  const common = path.resolve(repo.directory, repo.git("rev-parse", "--git-common-dir"), "agent-tracker");
  const directory = path.join(common, fs.readdirSync(common)[0], "lock");
  if (identity.retirementGate) fs.writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(settingsFile, "utf8")), lock: path.join(fs.realpathSync(path.dirname(directory)), "lock") }));
  return { ...repo, lock: directory, settingsFile };
}

function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  return child.pid;
}

function installLock(repo, pid, host = "Studio-Mac.local") {
  fs.mkdirSync(repo.lock);
  fs.writeFileSync(path.join(repo.lock, "owner.json"), JSON.stringify({ pid, host, token: "original-owner" }));
}

test("a dead controller recorded under the Mac system local hostname resumes its original durable generation", t => {
  const repo = hostFixture(t);
  repo.updateRemote(remote => { remote.deferDispatch = true; });
  assert.equal(resultJson(repo.run("claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket")).error, "publication_pending");
  const queued = JSON.parse(repo.remote().dispatches.at(-1));
  installLock(repo, deadPid());
  repo.updateRemote(remote => { remote.deferDispatch = false; });
  const resumed = repo.run("resume");
  assert.equal(resumed.status, 0, resumed.stderr);
  const state = resultJson(repo.run("show"));
  assert.equal(state.local.pending.length, 0);
  assert.equal(state.remote.owner.runId, "host-recovery");
  assert.equal(state.remote.owner.generation, 1);
  assert.equal(state.remote.receipts[queued.id].state, "published");
  assert.equal(state.remote.tickets[201].status, "implementing");
  assert.equal(fs.existsSync(repo.lock), false);
});

test("a live controller recorded under the Mac local hostname remains busy without touching its lock or registry", t => {
  const repo = hostFixture(t);
  installLock(repo, process.pid);
  const owner = fs.readFileSync(path.join(repo.lock, "owner.json"), "utf8");
  const registry = repo.remote().registry;
  const resumed = repo.run("resume");
  assert.equal(resultJson(resumed).error, "local_run_busy");
  assert.equal(fs.readFileSync(path.join(repo.lock, "owner.json"), "utf8"), owner);
  assert.equal(repo.remote().registry, registry);
});

for (const [name, identity, recordedHost] of [
  ["foreign hostname", {}, "Other-Mac.local"],
  ["alias discovery unavailable", { unavailable: true }],
  ["missing local hostname", { localHostName: undefined }],
  ["empty local hostname", { localHostName: "\n" }],
  ["local hostname containing a domain", { localHostName: "Studio-Mac.local\n" }],
  ["matching hostname containing a newline", { localHostName: "Studio-Mac\n\n" }, "Studio-Mac\n.local"],
  ["local hostname with extra output", { localHostName: "Studio-Mac\nOther-Mac\n" }],
  ["local hostname with whitespace", { localHostName: " Studio-Mac \n" }],
  ["local hostname with an invalid label", { localHostName: "-Studio-Mac\n" }],
  ["local hostname longer than one DNS label", { localHostName: "x".repeat(64) + "\n" }],
  ["non-Darwin system", { platform: "linux" }],
]) {
  test(`${name} cannot reclaim a dead alias lock`, t => {
    const repo = hostFixture(t, identity);
    installLock(repo, deadPid(), recordedHost);
    const owner = fs.readFileSync(path.join(repo.lock, "owner.json"), "utf8");
    const registry = repo.remote().registry;
    const resumed = repo.run("resume");
    assert.equal(resultJson(resumed).error, "local_lock_unverified");
    assert.equal(fs.readFileSync(path.join(repo.lock, "owner.json"), "utf8"), owner);
    assert.equal(repo.remote().registry, registry);
  });
}

test("the exact kernel hostname recovers without requiring Mac alias discovery", t => {
  const repo = hostFixture(t, { unavailable: true, platform: "linux" });
  installLock(repo, deadPid(), "Kernel-Mac");
  const resumed = repo.run("resume");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resultJson(repo.run("show")).remote.owner.generation, 1);
  assert.equal(fs.existsSync(repo.lock), false);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for isolated CLI processes");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function concurrentReclaim(t, retirementGate = false) {
  const repo = hostFixture(t, { gate: true, retirementGate });
  const linked = repo.linked();
  repo.updateRemote(remote => { remote.deferDispatch = true; });
  installLock(repo, deadPid());
  const clients = [repo, linked].map((client, index) => {
    const agent = `worker-${index}`;
    const child = client.spawn("claim", "--issue", "201", "--agent", agent, "--branch", "feat/ticket", "--wait-seconds", "600");
    const state = { child, agent, stderr: "", exited: false, code: null };
    child.stdout.resume();
    child.stderr.on("data", chunk => { state.stderr += chunk; });
    state.exit = new Promise(resolve => child.once("close", code => { state.exited = true; state.code = code; resolve(); }));
    t.after(async () => { if (!state.exited) child.kill("SIGKILL"); await state.exit; });
    return state;
  });
  // Both commands have read the same retired alias owner before either can elect a reclaimer.
  await waitFor(() => fs.readdirSync(path.dirname(repo.settingsFile)).filter(name => name.endsWith(".ready")).length === 2);
  fs.writeFileSync(`${repo.settingsFile}.release`, "");
  if (retirementGate) {
    await waitFor(() => fs.existsSync(`${repo.settingsFile}.retired`) && clients.some(client => client.exited));
    const refused = clients.find(client => client.exited);
    assert.equal(refused.code, 1, refused.stderr);
    assert.equal(JSON.parse(refused.stderr).error, "local_run_busy");
    fs.writeFileSync(`${repo.settingsFile}.continue`, "");
  }
  await waitFor(() => repo.remote().dispatches.length === 2 && clients.some(client => client.exited));
  const loser = clients.find(client => client.exited);
  assert.equal(loser.code, 1, loser.stderr);
  assert.ok(["local_run_busy", "local_lock_unverified"].includes(JSON.parse(loser.stderr).error), loser.stderr);
  const winner = clients.find(client => !client.exited);
  assert.ok(winner);
  const replacementOwner = fs.readFileSync(path.join(repo.lock, "owner.json"), "utf8");
  assert.equal(JSON.parse(replacementOwner).pid, winner.child.pid);
  assert.equal(JSON.parse(replacementOwner).host, "Kernel-Mac");
  assert.equal(resultJson(repo.run("show", "--local")).error, "local_run_busy");
  assert.equal(fs.readFileSync(path.join(repo.lock, "owner.json"), "utf8"), replacementOwner);
  winner.child.kill("SIGKILL");
  await winner.exit;
  repo.updateRemote(remote => { remote.deferDispatch = false; });
  assert.equal(repo.run("sync").status, 0);
  const state = resultJson(repo.run("show"));
  assert.equal(state.remote.owner.generation, 1);
  assert.equal(state.local.pending.length, 0);
  assert.equal(state.remote.tickets[201].status, "implementing");
  assert.equal(state.remote.tickets[201].agent, winner.agent);
  assert.equal(fs.existsSync(repo.lock), false);
}

test("concurrent Mac alias reclaimers retain one live lock and one durable claim", t => concurrentReclaim(t));
test("a reclaimer losing its parent during election refuses without replacing the winner", t => concurrentReclaim(t, true));
