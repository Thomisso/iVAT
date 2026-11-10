import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { trackerFixture, resultJson } from "./support/agent-tracker-fixture.mjs";
import { renderRegistry } from "../agent-tracking/state.mjs";

function execute(repo, ...args) {
  const result = repo.run(...args);
  assert.equal(result.status, 0, result.stderr);
  return resultJson(result);
}

test("status reports a missing cached snapshot without creating a journal or contacting GitHub", t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  repo.updateRemote(remote => { remote.fail = "unavailable"; });
  const directory = path.join(repo.directory, ".git", "agent-tracker");
  const before = repo.remote();
  const status = execute(repo, "status", "--issue", "201");
  assert.equal(status.source, "local_journal");
  assert.equal(status.confirmed.available, false);
  assert.equal(status.confirmed.observedAt, null);
  assert.deepEqual(status.issues, []);
  assert.deepEqual(status.pending, { count: 0, events: [] });
  assert.equal(status.nextStep, "sync");
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(repo.remote(), before);
});

test("status filters confirmed issue state and reports the actual snapshot observation time", t => {
  const repo = trackerFixture(t);
  repo.now("2026-11-05T12:00:00.000Z");
  assert.equal(repo.setup().status, 0);
  execute(repo, "start", "--run", "status-run");
  execute(repo, "claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket");
  execute(repo, "claim", "--issue", "202", "--agent", "other-worker", "--branch", "feat/ticket");
  repo.now("2026-11-05T12:05:00.000Z");
  const status = execute(repo, "status", "--issue", "201");
  assert.equal(status.confirmed.available, true);
  assert.equal(status.confirmed.observedAt, "2026-11-05T12:00:00.000Z");
  assert.equal(status.confirmed.ageMs, 300000);
  assert.equal(status.confirmed.owner.runId, "status-run");
  assert.equal(status.confirmed.revision, 3);
  assert.equal(status.projection.synchronized, true);
  assert.deepEqual(status.issues.map(issue => issue.number), [201]);
  assert.equal(status.issues[0].status, "implementing");
  assert.equal(status.issues[0].agent, "worker");
  assert.equal(status.issues[0].revision, 2);
  assert.equal(status.issues[0].handoffGate.state, "final_pr_required");
  assert.equal(execute(repo, "status").issues.length, 2);
  assert.equal(resultJson(repo.run("status", "--issue", "invalid")).error, "issue_invalid");
});

test("status remains read-only while a live writer waits and never promotes its pending claim", async t => {
  const repo = trackerFixture(t, { captureOutput: true });
  assert.equal(repo.setup().status, 0);
  execute(repo, "start", "--run", "busy-status-run");
  execute(repo, "claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket");
  repo.updateRemote(remote => { remote.deferDispatch = true; });
  const child = repo.spawn("claim", "--issue", "202", "--agent", "pending-worker", "--branch", "feat/ticket", "--wait-seconds", "600");
  child.stdout.resume(); child.stderr.resume();
  const exit = new Promise(resolve => child.once("close", resolve));
  t.after(async () => { child.kill("SIGKILL"); await exit; });
  const deadline = Date.now() + 10000;
  while ((repo.remote().dispatches?.length ?? 0) < 3) {
    assert.ok(Date.now() < deadline, "writer reached its dispatch");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(resultJson(repo.run("show", "--local")).error, "local_run_busy");
  const before = repo.remote();
  const status = execute(repo, "status", "--local");
  assert.deepEqual(status.issues.map(issue => issue.number), [201]);
  assert.equal(status.pending.count, 1);
  assert.equal(status.pending.events[0].issue, 202);
  assert.equal(status.pending.events[0].id, JSON.parse(before.dispatches.at(-1)).id);
  assert.equal(status.confirmed.revision, 2);
  assert.equal(status.nextStep, "sync");
  assert.deepEqual(repo.remote(), before);
});

test("status separates an incomplete observed projection from its last confirmed result", t => {
  const repo = trackerFixture(t);
  repo.now("2026-11-05T12:00:00.000Z");
  assert.equal(repo.setup().status, 0);
  execute(repo, "start", "--run", "partial-status-run");
  execute(repo, "claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket");
  repo.now("2026-11-05T12:01:00.000Z");
  repo.updateRemote(remote => { remote.failure = { match: "GET repos/example/project/issues/202/comments", phase: "before", remaining: 1 }; });
  assert.equal(resultJson(repo.run("claim", "--issue", "202", "--agent", "pending-worker", "--branch", "feat/ticket")).error, "publication_pending");
  const status = execute(repo, "status");
  assert.equal(status.confirmed.revision, 2);
  assert.equal(status.confirmed.observedAt, "2026-11-05T12:00:00.000Z");
  assert.equal(status.projection.revision, 3);
  assert.equal(status.projection.observedAt, "2026-11-05T12:01:00.000Z");
  assert.equal(status.projection.synchronized, false);
  assert.equal(status.projection.pendingReceipts, 1);
  assert.deepEqual(status.issues.map(issue => issue.number), [201]);
  assert.equal(status.pending.events[0].issue, 202);
});

test("status includes specification counts, bound PR and revision-specific gates without evidence dumps", t => {
  const repo = trackerFixture(t);
  const revision = repo.git("rev-parse", "feat/ticket");
  repo.updateRemote(remote => {
    remote.issues = {
      200: { id: "I_200", number: 200, title: "Specification", url: "https://github.com/example/project/issues/200", state: "OPEN", labels: [], body: "", subIssues: { totalCount: 1 }, repository: { nameWithOwner: "example/project" } },
      201: { id: "I_201", number: 201, title: "Implementation", url: "https://github.com/example/project/issues/201", state: "OPEN", labels: ["ready-for-agent"], body: "", parent: { id: "I_200", number: 200, title: "Specification", url: "https://github.com/example/project/issues/200", repository: { nameWithOwner: "example/project" } }, subIssues: { totalCount: 0 }, repository: { nameWithOwner: "example/project" } },
    };
    remote.subIssues = { 200: [201] };
    remote.pulls = { 300: { number: 300, node_id: "PR_300", html_url: "https://github.com/example/project/pull/300", state: "open", draft: true, merged: false, merged_at: null, head: { ref: "feat/ticket", sha: revision, repo: { full_name: "example/project" } }, base: { ref: "main", repo: { full_name: "example/project" } } } };
  });
  assert.equal(repo.setup().status, 0);
  execute(repo, "discover");
  execute(repo, "start", "--run", "gate-status-run");
  execute(repo, "claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket");
  execute(repo, "final-pr", "--issue", "200", "--pr", "300", "--result", "PR bound");
  let summary = execute(repo, "status", "--issue", "200").issues[0];
  assert.equal(summary.children.counts.implementing, 1);
  assert.equal(summary.final.pullRequest.number, 300);
  assert.equal(summary.final.revision, revision);
  assert.equal(summary.final.checks.status, "outstanding");
  assert.equal(summary.handoffGate.state, "final_checks_required");
  const checks = ["test:serial", "typecheck", "lint", "build", "runtime"].map(name => ({ name, status: "passed", evidence: "Synthetic check evidence" }));
  execute(repo, "final-checks", "--issue", "200", "--revision", revision, "--checks", JSON.stringify(checks), "--result", "Checks reported");
  summary = execute(repo, "status", "--issue", "200").issues[0];
  assert.equal(summary.final.checks.status, "passed");
  assert.equal(summary.handoffGate.state, "final_review_required");
  assert.equal(execute(repo, "status", "--issue", "200").nextStep, "final-review");
  execute(repo, "final-review", "--issue", "200", "--revision", revision, "--reviewer", "independent-reviewer", "--standards", "pass", "--spec", "pass", "--findings", "[]", "--independence", "Independent spec, base and diff review", "--evidence", "Synthetic review evidence", "--result", "Review reported");
  summary = execute(repo, "status", "--issue", "200").issues[0];
  assert.equal(summary.final.review.status, "passed");
  assert.equal(summary.handoffGate.state, "final_children_required");
  assert.equal(summary.handoffGate.authority, "cached_evidence_only");
  assert.equal(JSON.stringify(summary).includes("Synthetic check evidence"), false);
});

test("filtered status stays bounded when the confirmed registry has long receipt history and unrelated bodies", t => {
  const repo = trackerFixture(t);
  repo.now("2026-11-05T12:00:00.000Z");
  assert.equal(repo.setup().status, 0);
  execute(repo, "start", "--run", "long-status-run");
  execute(repo, "claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket");
  const before = JSON.stringify(execute(repo, "status", "--issue", "201"));
  const state = execute(repo, "show").remote;
  for (let index = 0; index < 2000; index++) state.receipts[`historical-${index}`] = { state: "published", revision: 0 };
  state.tickets[202] = { number: 202, title: "Unrelated title", body: "unrelated-private-document".repeat(2000), status: "ready", runId: null };
  repo.updateRemote(remote => { remote.registry = renderRegistry(state); });
  execute(repo, "sync");
  const result = repo.run("status", "--issue", "201");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("historical-"), false);
  assert.equal(result.stdout.includes("unrelated-private-document"), false);
  assert.ok(result.stdout.length <= before.length + 100);
  assert.equal(JSON.parse(result.stdout).issues.length, 1);
});

test("a partially written replacement journal cannot tear a concurrent status snapshot", async t => {
  const gate = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ivat-status-write-"));
  t.after(() => fs.rmSync(gate, { recursive: true, force: true }));
  const preload = new URL("./support/agent-tracker-journal-write.mjs", import.meta.url);
  preload.searchParams.set("gate", gate);
  const repo = trackerFixture(t, { nodeImports: [preload.href], captureOutput: true });
  repo.now("2026-11-05T12:00:00.000Z");
  assert.equal(repo.setup().status, 0);
  execute(repo, "start", "--run", "atomic-status-run");
  execute(repo, "claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket");
  const before = execute(repo, "status");
  fs.writeFileSync(path.join(gate, "arm"), "");
  const child = repo.spawn("sync");
  let stderr = ""; child.stdout.resume(); child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once("close", resolve));
  t.after(async () => { child.kill("SIGKILL"); await exited; });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(gate, "ready"))) {
    assert.ok(Date.now() < deadline, "writer reached the partial temporary file");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const during = execute(repo, "status");
  assert.deepEqual(during.confirmed, before.confirmed);
  assert.deepEqual(during.issues, before.issues);
  assert.equal(during.journalWrittenAt, before.journalWrittenAt);
  fs.writeFileSync(path.join(gate, "release"), "");
  assert.equal(await exited, 0, stderr);
  assert.equal(execute(repo, "status").confirmed.revision, before.confirmed.revision);
});

function handoffFixture(t) {
  const repo = trackerFixture(t);
  const revision = repo.git("rev-parse", "feat/ticket");
  repo.updateRemote(remote => {
    remote.issues = { 201: { id: "I_201", number: 201, title: "Implementation", url: "https://github.com/example/project/issues/201", state: "OPEN", labels: ["ready-for-agent"], body: "", parent: null, subIssues: { totalCount: 0 }, repository: { nameWithOwner: "example/project" } } };
    remote.pulls = { 300: { number: 300, node_id: "PR_300", html_url: "https://github.com/example/project/pull/300", state: "open", draft: true, merged: false, merged_at: null, head: { ref: "feat/ticket", sha: revision, repo: { full_name: "example/project" } }, base: { ref: "main", repo: { full_name: "example/project" } } } };
  });
  assert.equal(repo.setup().status, 0);
  execute(repo, "start", "--run", "refused-status-run");
  execute(repo, "claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket");
  execute(repo, "review", "--issue", "201", "--base", revision, "--revision", revision, "--checks", "Synthetic focused checks", "--result", "Implementation complete");
  execute(repo, "review-result", "--issue", "201", "--reviewer", "ticket-reviewer", "--revision", revision, "--standards", "pass", "--spec", "pass", "--findings", "[]", "--independence", "Independent ticket, base and diff review", "--result", "Review complete");
  execute(repo, "final-pr", "--issue", "201", "--pr", "300", "--result", "PR bound");
  const checks = ["focused", "typecheck", "lint", "runtime"].map(name => ({ name, status: "passed", evidence: "Synthetic check evidence" }));
  execute(repo, "final-checks", "--issue", "201", "--revision", revision, "--checks", JSON.stringify(checks), "--result", "Checks reported");
  execute(repo, "final-review", "--issue", "201", "--revision", revision, "--reviewer", "combined-reviewer", "--standards", "pass", "--spec", "pass", "--findings", "[]", "--independence", "Independent combined spec, base and diff review", "--evidence", "Synthetic review evidence", "--result", "Review reported");
  return { ...repo, revision };
}

for (const error of ["final_target_changed", "final_revision_changed"]) {
  test(`status preserves observed ${error} refusal and directs repair before another handoff`, t => {
    const repo = handoffFixture(t);
    repo.git("checkout", "-b", "concurrent-change", "main");
    fs.writeFileSync(path.join(repo.directory, "change.txt"), "Concurrent content\n");
    repo.git("add", "change.txt");
    repo.git("-c", "user.name=Status test", "-c", "user.email=status@example.test", "commit", "-m", "Concurrent change");
    const changed = repo.git("rev-parse", "HEAD");
    if (error === "final_target_changed") repo.git("branch", "-f", "main", changed);
    else repo.updateRemote(remote => { remote.pushDuringReady = changed; });
    assert.equal(resultJson(repo.run("final-handoff", "--issue", "201", "--result", "Attempt ready handoff")).error, error);
    const status = execute(repo, "status", "--issue", "201");
    assert.equal(status.issues[0].handoffGate.state, "refused");
    assert.equal(status.issues[0].handoffGate.error, error);
    assert.equal(status.issues[0].handoffGate.source, "last_observed");
    assert.equal(status.issues[0].observedHandoff.error, error);
    assert.equal(status.nextStep, error === "final_target_changed" ? "incorporate_target_and_repeat_checks_review" : "rebind_pr_and_repeat_checks_review");
    execute(repo, "sync");
    const confirmed = execute(repo, "status", "--issue", "201");
    assert.equal(confirmed.issues[0].final.handoff.error, error);
    assert.equal(confirmed.issues[0].handoffGate.state, "refused");
  });
}
