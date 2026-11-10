import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { trackerFixture, resultJson } from "./support/agent-tracker-fixture.mjs";

function pollingFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-polling-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = path.join(root, "plan.json");
  const preload = new URL("./support/agent-tracker-polling.mjs", import.meta.url);
  preload.searchParams.set("plan", plan);
  const repo = trackerFixture(t, { nodeImports: [preload.href], captureOutput: true });
  const at = "2026-11-05T12:00:00.000Z";
  repo.now(at);
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("start", "--run", "polling-run").status, 0);
  return {
    ...repo,
    arm(mode, deliverAt = Number.MAX_SAFE_INTEGER) {
      fs.writeFileSync(plan, JSON.stringify({ startedAt: Date.parse(at), deliverAt, mode }));
      repo.updateRemote(remote => { remote.deferDispatch = true; });
    },
    claim(seconds) {
      return new Promise(resolve => {
        const child = repo.spawn("claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket", "--wait-seconds", String(seconds));
        const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
        t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill("SIGKILL"); });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("close", status => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
      });
    },
    sleeps: () => fs.existsSync(`${plan}.sleeps`) ? fs.readFileSync(`${plan}.sleeps`, "utf8").trim().split("\n").map(Number) : [],
    reads: () => fs.readFileSync(`${plan}.reads`, "utf8").trim().split("\n").map(Number),
  };
}

test("long receipt waits back off within a fixed deadline without treating elapsed time as success", async t => {
  const repo = pollingFixture(t);
  repo.arm("pending");
  const result = await repo.claim(120);
  assert.equal(resultJson(result).error, "publication_pending");
  assert.deepEqual(repo.sleeps().slice(0, 4), [1000, 2000, 4000, 5000]);
  assert.equal(repo.sleeps().reduce((sum, delay) => sum + delay, 0), 120000);
  assert.ok(repo.reads().length < 35, "bounded request count during two virtual minutes");
});

test("the final backoff interval is clipped to the remaining deadline", async t => {
  const repo = pollingFixture(t);
  repo.arm("pending");
  const result = await repo.claim(2.5);
  assert.equal(resultJson(result).error, "publication_pending");
  assert.deepEqual(repo.sleeps(), [1000, 1500]);
});

for (const mode of ["published", "rejected", "failure"]) {
  test(`receipt polling preserves actual ${mode} authority after a delayed response`, async t => {
    const repo = pollingFixture(t);
    if (mode === "rejected") assert.equal(repo.run("claim", "--issue", "201", "--agent", "original-worker", "--branch", "feat/ticket").status, 0);
    repo.arm(mode, 7000);
    const result = await repo.claim(20);
    if (mode === "published") {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(resultJson(result).synchronized, true);
      const shown = resultJson(repo.run("show"));
      const event = JSON.parse(repo.remote().dispatches.at(-1));
      assert.equal(shown.remote.receipts[event.id].state, "published");
      assert.equal(shown.remote.receipts[event.id].runId, "polling-run");
      assert.equal(shown.remote.receipts[event.id].revision, shown.local.publishedRevision);
      assert.equal(shown.local.pending.length, 0);
    } else assert.equal(resultJson(result).error, mode === "rejected" ? "ticket_already_claimed" : "publication_pending");
    assert.deepEqual(repo.sleeps(), [1000, 2000, 4000]);
  });
}
