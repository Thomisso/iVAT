import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { trackerFixture, resultJson } from "./support/agent-tracker-fixture.mjs";

function waitForFile(file) {
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(path.dirname(file), check);
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error("Timed out waiting for fixture publication"));
    }, 10000);
    function check() {
      if (!fs.existsSync(file)) return;
      clearTimeout(timer);
      watcher.close();
      resolve();
    }
    check();
  });
}

test("concurrent CLI readers observe complete fixture state while a claim is being published", async t => {
  const gate = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-tracker-publication-"));
  t.after(() => fs.rmSync(gate, { recursive: true, force: true }));
  const preload = new URL("./support/agent-tracker-publication.mjs", import.meta.url);
  preload.searchParams.set("gate", gate);
  const repo = trackerFixture(t, { nodeImports: [preload.href], captureOutput: true });
  assert.equal(repo.setup().status, 0);
  const reader = repo.clone();
  assert.equal(reader.setup().status, 0);
  assert.equal(repo.run("start", "--run", "publication-owner").status, 0);
  repo.updateRemote(state => { state.deferDispatch = true; });
  const writer = repo.spawn("claim", "--issue", "201", "--agent", "publication-worker", "--branch", "feat/ticket", "--wait-seconds", "0");
  let stderr = "";
  writer.stdout.resume();
  writer.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => writer.once("close", resolve));
  try {
    await waitForFile(path.join(gate, "ready"));
    let snapshot;
    assert.doesNotThrow(() => { snapshot = repo.remote(); }, "A concurrent fixture reader must receive a complete published snapshot");
    assert.equal(snapshot.dispatches.length, 1);
    const observed = reader.run("show");
    assert.equal(observed.status, 0, observed.stderr);
    assert.equal(resultJson(observed).remote.owner.runId, "publication-owner");
  } finally {
    fs.writeFileSync(path.join(gate, "release"), "");
    await exited;
  }
  assert.equal(writer.exitCode, 1, stderr);
  assert.equal(JSON.parse(stderr).error, "publication_pending");
  const claim = JSON.parse(repo.remote().dispatches.at(-1));
  assert.equal(claim.type, "claim");
  assert.equal(repo.worker(claim).status, 0);
  repo.updateRemote(state => { state.deferDispatch = false; });
  assert.equal(repo.run("sync").status, 0);
  const state = resultJson(repo.run("show"));
  assert.equal(state.local.pending.length, 0);
  assert.equal(state.remote.owner.runId, "publication-owner");
  assert.equal(state.remote.owner.generation, 1);
  assert.equal(state.remote.tickets[201].agent, "publication-worker");
  assert.equal(state.remote.tickets[201].status, "implementing");
});

test("a delayed CLI reader cannot overwrite a newer published claim in the fixture", async t => {
  const gate = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-tracker-reader-"));
  t.after(() => fs.rmSync(gate, { recursive: true, force: true }));
  const preload = new URL("./support/agent-tracker-publication.mjs", import.meta.url);
  preload.searchParams.set("gate", gate);
  preload.searchParams.set("mode", "read");
  const repo = trackerFixture(t, { nodeImports: [preload.href], captureOutput: true });
  assert.equal(repo.setup().status, 0);
  const observer = repo.clone();
  assert.equal(observer.setup().status, 0);
  assert.equal(repo.run("start", "--run", "publication-owner").status, 0);
  fs.writeFileSync(path.join(gate, "arm"), "");
  const reader = observer.spawn("show");
  let stderr = "";
  reader.stdout.resume();
  reader.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => reader.once("close", resolve));
  try {
    await waitForFile(path.join(gate, "ready"));
    const claimed = repo.run("claim", "--issue", "201", "--agent", "publication-worker", "--branch", "feat/ticket");
    assert.equal(claimed.status, 0, claimed.stderr);
  } finally {
    fs.writeFileSync(path.join(gate, "release"), "");
    await exited;
  }
  assert.equal(reader.exitCode, 0, stderr);
  assert.equal(repo.remote().dispatches.length, 2);
  const current = resultJson(repo.run("show")).remote;
  assert.equal(current.owner.runId, "publication-owner");
  assert.equal(current.owner.generation, 1);
  assert.equal(current.tickets[201].agent, "publication-worker");
  assert.equal(current.tickets[201].status, "implementing");
});
