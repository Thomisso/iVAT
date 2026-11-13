import assert from "node:assert/strict";
import test from "node:test";
import { trackerFixture, resultJson } from "./support/agent-tracker-fixture.mjs";

function pendingClaim(t, workflowRun = { status: "queued" }) {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("start", "--run", "dispatch-owner").status, 0);
  repo.updateRemote(remote => { remote.deferDispatch = true; remote.workflowRun = workflowRun; });
  assert.equal(resultJson(repo.run("claim", "--issue", "201", "--agent", "first-worker", "--branch", "feat/ticket")).error, "publication_pending");
  return repo;
}

for (const status of ["queued", "pending", "requested", "waiting", "in_progress"]) {
  test(`appending future CLI intents preserves the single ${status} dispatch across process and worktree restart`, t => {
    const repo = pendingClaim(t, { status });
    const head = repo.remote().dispatches.at(-1);
    const linked = repo.linked();
    for (const issue of [202, 203]) {
      assert.equal(resultJson(linked.run("claim", "--issue", String(issue), "--agent", `worker-${issue}`, "--branch", "feat/ticket")).error, "publication_pending");
    }
    assert.equal(resultJson(repo.run("sync")).error, "publication_pending");
    const shown = resultJson(repo.run("show"));
    assert.deepEqual(shown.local.pending.map(event => event.payload.issue), [201, 202, 203]);
    assert.deepEqual(shown.local.pending.map(event => event.sequence), [1, 2, 3]);
    assert.equal(JSON.stringify(shown.local.pending[0]), head);
    assert.equal(shown.local.run.generation, 1);
    assert.equal(shown.remote.owner.sequence, 0);
    assert.deepEqual(repo.remote().dispatches.slice(1), [head], "the provider has one head dispatch and no later intent dispatch");
  });
}

test("a completed workflow without receipt retries the original envelope before any later intent", t => {
  const repo = pendingClaim(t);
  const original = repo.remote().dispatches.at(-1);
  assert.equal(resultJson(repo.run("claim", "--issue", "202", "--agent", "next-worker", "--branch", "feat/ticket")).error, "publication_pending");
  repo.updateRemote(remote => { remote.workflowRun = { status: "completed", conclusion: "success" }; });
  assert.equal(resultJson(repo.run("sync")).error, "publication_pending");
  const pending = resultJson(repo.run("show"));
  assert.deepEqual(pending.local.pending.map(event => event.payload.issue), [201, 202]);
  assert.deepEqual(repo.remote().dispatches.slice(1), [original, original]);
  assert.equal(pending.remote.receipts[JSON.parse(original).id], undefined, "workflow success is not an acknowledgment");
  assert.equal(pending.remote.owner.sequence, 0);
  // The same event reaches the real worker, then receipt-first sync advances FIFO.
  assert.equal(repo.worker(JSON.parse(original)).status, 0);
  repo.updateRemote(remote => { remote.workflowRun = { status: "in_progress" }; });
  assert.equal(resultJson(repo.run("sync")).error, "publication_pending");
  const next = repo.remote().dispatches.at(-1);
  assert.equal(JSON.parse(next).payload.issue, 202);
  assert.equal(JSON.parse(next).sequence, 2);
  assert.deepEqual(resultJson(repo.run("show", "--local")).local.pending.map(event => event.payload.issue), [202]);
  assert.equal(repo.worker(JSON.parse(next)).status, 0);
  assert.equal(repo.run("sync").status, 0);
  const completed = resultJson(repo.run("show"));
  assert.equal(completed.local.pending.length, 0);
  assert.equal(completed.remote.owner.sequence, 2);
  assert.equal(completed.remote.tickets[201].status, "implementing");
  assert.equal(completed.remote.tickets[202].status, "implementing");
});

test("a terminal receipt arriving during the completed-run read is consumed without redispatch", t => {
  const repo = pendingClaim(t, { status: "completed" });
  const original = repo.remote().dispatches.at(-1);
  repo.updateRemote(remote => { remote.runReadWorker = JSON.parse(original); });
  assert.equal(repo.run("sync").status, 0);
  const shown = resultJson(repo.run("show"));
  assert.equal(shown.local.pending.length, 0);
  assert.equal(shown.remote.receipts[JSON.parse(original).id].state, "published");
  assert.deepEqual(repo.remote().dispatches.slice(1), [original]);
});

for (const outcome of ["published", "rejected"]) {
  test(`a ${outcome} receipt outranks unavailable mapped-run metadata after process restart`, t => {
    const repo = pendingClaim(t);
    let original = repo.remote().dispatches.at(-1);
    const before = repo.remote().dispatches.length;
    assert.equal(repo.worker(JSON.parse(original)).status, 0);
    if (outcome === "rejected") {
      assert.equal(repo.run("sync").status, 0);
      assert.equal(resultJson(repo.run("claim", "--issue", "201", "--agent", "conflicting-worker", "--branch", "feat/ticket")).error, "publication_pending");
      original = repo.remote().dispatches.at(-1);
      assert.equal(resultJson(repo.worker(JSON.parse(original))).error, "ticket_already_claimed");
    }
    repo.updateRemote(remote => { remote.failure = { match: "GET repos/example/project/actions/runs/123", phase: "before", remaining: 1 }; });
    const synced = repo.run("sync");
    assert.equal(outcome === "published" ? synced.status : resultJson(synced).error, outcome === "published" ? 0 : "ticket_already_claimed");
    const shown = resultJson(repo.run("show"));
    assert.equal(shown.local.pending.length, 0);
    assert.equal(shown.remote.receipts[JSON.parse(original).id].state, outcome);
    assert.equal(repo.remote().failure.remaining, 1, "receipt recovery does not depend on Actions access");
    assert.equal(repo.remote().dispatches.length, before + (outcome === "rejected" ? 1 : 0));
    assert.equal(repo.remote().dispatches.at(-1), original);
  });
}

test("unverified run identity and malformed metadata preserve the durable unresolved FIFO", t => {
  const repo = pendingClaim(t);
  const head = repo.remote().dispatches.at(-1);
  const original = resultJson(repo.run("show"));
  const invalid = [
    { id: 999 }, { id: "123" }, { repository: null }, { repository: { full_name: "other/project" } },
    { path: ".github/workflows/other.yml" }, { path: null }, { event: "push" },
    { status: "success" }, { status: "cancelled" }, { status: null },
  ];
  for (const metadata of invalid) {
    repo.updateRemote(remote => { remote.workflowRun = { status: "completed", ...metadata }; });
    assert.equal(resultJson(repo.run("sync")).error, "publication_pending", JSON.stringify(metadata));
    assert.equal(resultJson(repo.run("show", "--local")).local.publicationError.code, "workflow_run_unverified");
  }
  for (const response of [null, [], "unexpected response"]) {
    repo.updateRemote(remote => { remote.workflowRunResponse = response; });
    assert.equal(resultJson(repo.run("sync")).error, "publication_pending");
  }
  const after = resultJson(repo.run("show"));
  assert.deepEqual(after.local.pending, original.local.pending);
  assert.deepEqual(after.local.run, original.local.run);
  assert.deepEqual(after.remote, original.remote);
  assert.deepEqual(repo.remote().dispatches.slice(1), [head]);
});

test("failed mapped-run reads keep all queued intents pending without leaking provider diagnostics", t => {
  const repo = pendingClaim(t);
  const original = repo.remote().dispatches.at(-1);
  for (const [message, code] of [["network unavailable PRIVATE_PROVIDER_DIAGNOSTIC", "github_connection_failed"], ["HTTP 403: forbidden PRIVATE_PROVIDER_DIAGNOSTIC", "github_permission_denied"], ["HTTP 404: not found PRIVATE_PROVIDER_DIAGNOSTIC", "github_not_found"]]) {
    repo.updateRemote(remote => { remote.failure = { match: "GET repos/example/project/actions/runs/123", phase: "before", remaining: 1, message }; });
    const result = repo.run("claim", "--issue", "202", "--agent", "queued-worker", "--branch", "feat/ticket");
    assert.equal(resultJson(result).error, "publication_pending");
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_PROVIDER_DIAGNOSTIC/);
    assert.equal(resultJson(repo.run("show", "--local")).local.publicationError.code, code);
  }
  assert.deepEqual(resultJson(repo.run("show", "--local")).local.pending.map(event => event.payload.issue), [201, 202, 202, 202]);
  assert.deepEqual(repo.remote().dispatches.slice(1), [original]);
});

test("a lost dispatch response without run mapping retains the existing same-envelope recovery", t => {
  const repo = trackerFixture(t);
  assert.equal(repo.setup().status, 0);
  assert.equal(repo.run("start", "--run", "lost-response-owner").status, 0);
  repo.updateRemote(remote => {
    remote.deferDispatch = true;
    remote.workflowRun = { status: "queued" };
    remote.failure = { match: "POST repos/example/project/actions/workflows/agent-tracking.yml/dispatches", phase: "after", remaining: 1 };
  });
  assert.equal(resultJson(repo.run("claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket")).error, "publication_pending");
  const original = repo.remote().dispatches.at(-1);
  assert.equal(resultJson(repo.run("show", "--local")).local.dispatches[JSON.parse(original).id], undefined);
  assert.equal(resultJson(repo.run("sync")).error, "publication_pending");
  assert.deepEqual(repo.remote().dispatches.slice(1), [original, original], "ambiguous POST can create another workflow, preserving the exact logical event");
  assert.equal(repo.worker(JSON.parse(original)).status, 0);
  assert.equal(repo.run("sync").status, 0);
  assert.equal(resultJson(repo.run("show", "--local")).local.pending.length, 0);
});
