import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { trackerFixture, resultJson } from "./support/agent-tracker-fixture.mjs";

function execute(repo, ...args) {
  const result = repo.run(...args);
  assert.equal(result.status, 0, result.stderr);
  return resultJson(result);
}

function prepare(t) {
  const repo = trackerFixture(t);
  repo.git("checkout", "feat/ticket");
  writeFileSync(path.join(repo.directory, "implementation.txt"), "Reviewed implementation\n");
  repo.git("add", "implementation.txt");
  repo.git("-c", "user.name=Finalize fixture", "-c", "user.email=finalize@example.test", "commit", "-m", "Implementation");
  const revision = repo.git("rev-parse", "HEAD");
  repo.updateRemote(remote => {
    remote.issues = { 201: { id: "I_201", number: 201, title: "Implementation", url: "https://github.com/example/project/issues/201", state: "OPEN", labels: ["ready-for-agent"], body: "", parent: null, subIssues: { totalCount: 0 }, repository: { nameWithOwner: "example/project" } } };
    remote.parents = { 201: null };
    remote.pulls = { 300: { number: 300, node_id: "PR_300", html_url: "https://github.com/example/project/pull/300", state: "open", draft: true, merged: false, merged_at: null, head: { ref: "feat/ticket", sha: revision, repo: { full_name: "example/project" } }, base: { ref: "main", repo: { full_name: "example/project" } } } };
  });
  assert.equal(repo.setup().status, 0);
  execute(repo, "discover"); execute(repo, "start", "--run", "finalize-run");
  execute(repo, "claim", "--issue", "201", "--agent", "implementer", "--branch", "feat/ticket");
  execute(repo, "review", "--issue", "201", "--base", repo.git("rev-parse", "main"), "--revision", revision, "--checks", "Focused tests, typecheck and lint passed", "--result", "Implementation complete");
  execute(repo, "review-result", "--issue", "201", "--reviewer", "ticket-reviewer", "--revision", revision, "--standards", "pass", "--spec", "pass", "--findings", "[]", "--independence", "Independent ticket/base/diff review", "--result", "No findings");
  const evidence = { revision, result: "Controller reports observed final evidence", checks: ["focused", "typecheck", "lint", "runtime"].map(name => ({ name, status: "passed", evidence: `https://github.com/example/project/actions/runs/123#${name}` })), review: { reviewer: "final-reviewer", standards: "pass", spec: "pass", findings: [], independence: "Reviewer received whole specification, base and combined diff without implementation context", evidence: "https://github.com/example/project/issues/201#issuecomment-123" } };
  const file = path.join(repo.directory, "evidence.json");
  const saveEvidence = () => writeFileSync(file, JSON.stringify(evidence));
  saveEvidence();
  const finalize = (...extra) => repo.run("finalize", "--issue", "201", "--pr", "300", "--revision", revision, "--evidence-file", file, ...extra);
  return { ...repo, revision, evidence, file, saveEvidence, finalize };
}

test("finalize confirms a stale PR binding before publishing exact-revision evidence and ready handoff", t => {
  const repo = prepare(t);
  repo.updateRemote(remote => { remote.pulls[300].head.sha = repo.git("rev-parse", "main"); });
  execute(repo, "final-pr", "--issue", "201", "--pr", "300", "--result", "Earlier binding");
  repo.updateRemote(remote => { remote.pulls[300].head.sha = repo.revision; remote.dispatches = []; });
  const result = repo.finalize();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(resultJson(result).finalization.state, "complete");
  const events = repo.remote().dispatches.map(JSON.parse).filter(event => event.type.startsWith("final-"));
  assert.deepEqual(events.map(event => event.type), ["final-pr", "final-checks", "final-review", "final-handoff"]);
  assert.equal(repo.remote().readyTransitions, 1);
  assert.equal(execute(repo, "show").remote.tickets[201].final.checks.revision, repo.revision);
});

test("a lost ready response resumes the saved inputs and original event without another handoff envelope", t => {
  const repo = prepare(t);
  repo.now("2026-11-05T12:00:00.000Z");
  repo.updateRemote(remote => { remote.failure = { match: "TrackerReady", phase: "after", remaining: 1 }; remote.dispatches = []; });
  const lost = repo.finalize();
  assert.equal(resultJson(lost).error, "publication_pending");
  const original = repo.remote().dispatches.map(JSON.parse).find(event => event.type === "final-handoff");
  assert.equal(repo.remote().pulls[300].draft, false);
  unlinkSync(repo.file);
  repo.now("2026-11-05T12:10:00.000Z");
  execute(repo, "finalize", "--issue", "201");
  const handoffs = repo.remote().dispatches.map(JSON.parse).filter(event => event.type === "final-handoff");
  assert.deepEqual([...new Set(handoffs.map(event => event.id))], [original.id]);
  assert.ok(handoffs.every(event => event.at === "2026-11-05T12:00:00.000Z"));
  assert.equal(repo.remote().readyTransitions, 1);
});

test("failed evidence remains failed and a rejected attempt requires explicit replacement", t => {
  const repo = prepare(t);
  repo.evidence.checks.find(check => check.name === "lint").status = "failed";
  repo.saveEvidence();
  assert.equal(resultJson(repo.finalize()).error, "final_checks_required");
  const count = repo.remote().dispatches.length;
  assert.equal(resultJson(repo.run("finalize", "--issue", "201")).error, "final_checks_required");
  assert.equal(repo.remote().dispatches.length, count, "a rejected workflow never resubmits its terminal event");
  assert.equal(execute(repo, "show").remote.tickets[201].final.checks.results.find(check => check.name === "lint").status, "failed");
  repo.evidence.checks.find(check => check.name === "lint").status = "passed";
  repo.saveEvidence();
  assert.equal(resultJson(repo.finalize()).error, "finalization_inputs_changed");
  assert.equal(repo.finalize("--new-attempt").status, 0);
  const attempts = execute(repo, "show", "--local").local.finalizations;
  assert.equal(attempts[0].state, "rejected");
  assert.equal(attempts[1].state, "complete");
});

test("preflight reports expected and actual SHA with the blocked step before publishing evidence", t => {
  const repo = prepare(t);
  const actual = repo.git("rev-parse", "main");
  repo.updateRemote(remote => { remote.pulls[300].head.sha = actual; remote.dispatches = []; });
  const error = resultJson(repo.finalize());
  assert.equal(error.error, "final_revision_changed");
  assert.deepEqual(error.finalization, { issue: 201, pr: 300, step: "final-pr", expectedRevision: repo.revision, actualRevision: actual });
  assert.equal(repo.remote().dispatches.length, 0);
});

test("a head change after local preflight cannot bind a different revision in the writer", t => {
  const repo = prepare(t);
  repo.updateRemote(remote => { remote.pushOnPullRead = { remaining: 3, sha: repo.git("rev-parse", "main") }; remote.dispatches = []; });
  assert.equal(resultJson(repo.finalize()).error, "final_revision_changed");
  const shown = execute(repo, "show");
  assert.equal(shown.remote.tickets[201].final, undefined);
  assert.equal(shown.local.finalizations[0].steps["final-pr"].state, "rejected");
  assert.deepEqual(repo.remote().dispatches.map(JSON.parse).map(event => event.type), ["final-pr"]);
});

for (const interruption of ["dispatch", "projection"]) {
  test(`restart after ${interruption} interruption preserves pending UUID/time and saves no duplicate evidence`, t => {
    const repo = prepare(t);
    repo.now("2026-11-05T12:00:00.000Z");
    repo.updateRemote(remote => {
      remote.dispatches = [];
      if (interruption === "dispatch") {
        remote.deferDispatch = true;
        remote.failure = { match: "POST repos/example/project/actions/workflows/agent-tracking.yml/dispatches", phase: "after", remaining: 1 };
      } else remote.failure = { match: "TrackerSetFields", phase: "after", remaining: 1 };
    });
    const interrupted = resultJson(repo.finalize());
    assert.equal(interrupted.error, "publication_pending");
    assert.equal(interrupted.finalization.step, "final-pr");
    assert.equal(interrupted.finalization.state, "running");
    const original = JSON.parse(repo.remote().dispatches[0]);
    assert.equal(original.type, "final-pr");
    repo.updateRemote(remote => { remote.deferDispatch = false; });
    repo.now("2026-11-05T12:10:00.000Z");
    execute(repo, "finalize", "--issue", "201");
    const events = repo.remote().dispatches.map(JSON.parse);
    assert.deepEqual([...new Set(events.filter(event => event.type === "final-pr").map(event => event.id))], [original.id]);
    assert.ok(events.filter(event => event.type === "final-pr").every(event => event.at === original.at));
    for (const type of ["final-checks", "final-review", "final-handoff"]) assert.equal(events.filter(event => event.type === type).length, 1);
    assert.equal(repo.remote().readyTransitions, 1);
  });
}

test("a head change between acknowledged binding and evidence stops at final-checks with saved inputs intact", t => {
  const repo = prepare(t);
  repo.updateRemote(remote => { remote.deferDispatch = true; remote.dispatches = []; });
  assert.equal(resultJson(repo.finalize()).error, "publication_pending");
  const event = JSON.parse(repo.remote().dispatches[0]);
  assert.equal(repo.worker(event).status, 0);
  repo.updateRemote(remote => { remote.deferDispatch = false; remote.pulls[300].head.sha = repo.git("rev-parse", "main"); });
  const result = resultJson(repo.run("finalize", "--issue", "201"));
  assert.equal(result.error, "final_revision_changed");
  assert.equal(result.finalization.step, "final-checks");
  assert.equal(repo.remote().dispatches.map(JSON.parse).some(event => event.type === "final-checks"), false);
  assert.equal(execute(repo, "show", "--local").local.finalizations[0].evidence.revision, repo.revision);
});

test("evidence inputs cannot override the attempt issue or revision through review fields", t => {
  const repo = prepare(t);
  repo.evidence.review.issue = "202";
  repo.saveEvidence();
  repo.updateRemote(remote => { remote.dispatches = []; });
  assert.equal(resultJson(repo.finalize()).error, "finalization_evidence_invalid");
  assert.equal(repo.remote().dispatches.length, 0);
});

test("a manual binding change between processes cannot send saved evidence or readiness to another PR", t => {
  const repo = prepare(t);
  repo.updateRemote(remote => { remote.deferDispatch = true; remote.dispatches = []; });
  assert.equal(resultJson(repo.finalize()).error, "publication_pending");
  const event = JSON.parse(repo.remote().dispatches[0]);
  assert.equal(repo.worker(event).status, 0);
  repo.updateRemote(remote => {
    remote.deferDispatch = false;
    remote.pulls[301] = { ...remote.pulls[300], number: 301, node_id: "PR_301", html_url: "https://github.com/example/project/pull/301" };
  });
  execute(repo, "sync");
  execute(repo, "final-pr", "--issue", "201", "--pr", "301", "--result", "Different deliberate binding");
  const result = resultJson(repo.run("finalize", "--issue", "201"));
  assert.equal(result.error, "final_pr_changed");
  assert.equal(repo.remote().pulls[300].draft, true);
  assert.equal(repo.remote().pulls[301].draft, true);
  assert.equal(execute(repo, "show").remote.tickets[201].final.checks, undefined);
});


test("an abruptly killed controller resumes the same saved event under the recovered local lock", async t => {
  const repo = prepare(t);
  repo.updateRemote(remote => { remote.deferDispatch = true; remote.dispatches = []; });
  const child = repo.spawn("finalize", "--issue", "201", "--pr", "300", "--revision", repo.revision, "--evidence-file", repo.file, "--wait-seconds", "600");
  const exited = new Promise(resolve => child.once("close", resolve));
  t.after(async () => { child.kill("SIGKILL"); await exited; });
  const deadline = Date.now() + 10000;
  while (!repo.remote().dispatches.length) {
    assert.ok(Date.now() < deadline, "controller saved and dispatched its first event");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const original = JSON.parse(repo.remote().dispatches[0]);
  child.kill("SIGKILL"); await exited;
  repo.updateRemote(remote => { remote.deferDispatch = false; });
  execute(repo, "finalize", "--issue", "201");
  const bindings = repo.remote().dispatches.map(JSON.parse).filter(event => event.type === "final-pr");
  assert.deepEqual([...new Set(bindings.map(event => event.id))], [original.id]);
  assert.ok(bindings.every(event => event.at === original.at));
  assert.equal(repo.remote().readyTransitions, 1);
});
