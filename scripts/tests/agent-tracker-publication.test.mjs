import assert from "node:assert/strict";
import test from "node:test";
import { trackerFixture, resultJson } from "./support/agent-tracker-fixture.mjs";

function execute(repo, ...args) {
  const result = repo.run(...args);
  assert.equal(result.status, 0, result.stderr);
  return resultJson(result);
}
function mutations(repo) {
  return (repo.remote().requests ?? []).filter(request => request.operation.startsWith("Tracker") ? /^(TrackerAddItem|TrackerSetFields|TrackerCreateView|TrackerUpdateView)$/.test(request.operation) : request.method !== "GET" && request.endpoint !== "repos/example/project/issues/comments/900" && !request.endpoint.includes("/dispatches"));
}
function begin(t) {
  const repo = trackerFixture(t);
  repo.now("2026-11-05T12:00:00.000Z");
  assert.equal(repo.setup().status, 0);
  execute(repo, "start", "--run", "publication-run");
  execute(repo, "claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket");
  execute(repo, "reconcile");
  repo.updateRemote(remote => { remote.requests = []; });
  return repo;
}

test("duplicate passive wakeups acknowledge without rewriting unchanged external projections", t => {
  const repo = begin(t);
  for (const run of [401, 402, 403]) {
    const result = repo.worker(null, { GITHUB_EVENT_NAME: "issues", GITHUB_RUN_ID: String(run) });
    assert.equal(result.status, 0, result.stderr);
  }
  const state = execute(repo, "show").remote;
  for (const run of [401, 402, 403]) assert.equal(state.receipts[`discovery-${run}`].state, "published");
  assert.deepEqual(mutations(repo).map(request => request.operation), []);
  execute(repo, "stop", "--reason", "Stop after passive burst", "--at", "2026-11-05T12:01:00.000Z");
  const stop = JSON.parse(repo.remote().dispatches.at(-1));
  assert.equal(stop.type, "stop");
  assert.equal(stop.sequence, 2);
  assert.equal(stop.at, "2026-11-05T12:01:00.000Z");
  const stopped = execute(repo, "show").remote;
  assert.equal(stopped.owner, null);
  assert.equal(stopped.receipts[stop.id].state, "published");
});

test("a lost field response retries only the unfinished projection and preserves the owned stop envelope", t => {
  const repo = begin(t);
  repo.now("2026-11-05T12:03:00.000Z");
  repo.updateRemote(remote => { remote.failure = { match: "TrackerSetFields", phase: "after", remaining: 1 }; });
  const stop = repo.run("stop", "--reason", "Workers finished", "--at", "2026-11-05T12:02:00.000Z");
  assert.equal(resultJson(stop).error, "publication_pending");
  const envelope = JSON.parse(repo.remote().dispatches.at(-1));
  assert.equal(envelope.type, "stop");
  assert.equal(envelope.sequence, 2);
  assert.equal(envelope.at, "2026-11-05T12:02:00.000Z");
  assert.equal(execute(repo, "show").remote.receipts[envelope.id].state, "pending");
  repo.updateRemote(remote => { remote.requests = []; });
  execute(repo, "sync");
  assert.deepEqual(JSON.parse(repo.remote().dispatches.at(-1)), envelope);
  const state = execute(repo, "show").remote;
  assert.equal(state.owner, null);
  assert.equal(state.receipts[envelope.id].state, "published");
  assert.equal(state.runHistory[1].endedAt, envelope.at);
  assert.equal(state.runHistory[1].eventId, envelope.id);
  assert.deepEqual(mutations(repo).map(request => request.operation), ["PATCH repos/example/project/issues/comments/901"]);
});

test("unchanged facts still repair missing membership, assignees, comments and views", t => {
  const repo = begin(t);
  repo.updateRemote(remote => {
    delete remote.items.I_201;
    remote.assignees = [];
    remote.ticketComments = [];
    remote.views[0].filter = "manual-filter";
    remote.views.splice(1, 1);
  });
  execute(repo, "reconcile");
  const operations = mutations(repo).map(request => request.operation);
  assert.deepEqual(operations, ["TrackerAddItem", "POST repos/example/project/issues/201/assignees", "TrackerSetFields", "POST repos/example/project/issues/201/comments", "TrackerUpdateView", "TrackerCreateView"]);
  const state = execute(repo, "show").remote;
  assert.equal(state.tickets[201].manualConflict.kind, "membership_missing");
  assert.equal(state.tickets[201].status, "implementing");
  assert.equal(state.publishedRevision, state.revision);
  assert.equal(repo.remote().ticketComments.length, 1);
  assert.equal(repo.remote().views.length, 2);
  repo.updateRemote(remote => { remote.requests = []; });
  execute(repo, "reconcile");
  assert.deepEqual(mutations(repo).map(request => request.operation), []);
});

test("item read failures preserve canonical evidence and retry the same reconciliation without inventing missing membership", t => {
  const repo = begin(t);
  repo.updateRemote(remote => { remote.deferDispatch = true; });
  assert.equal(resultJson(repo.run("reconcile")).error, "publication_pending");
  const event = JSON.parse(repo.remote().dispatches.at(-1));
  const before = execute(repo, "show").remote;
  const missing = { type: "NOT_FOUND", path: ["node"], message: "Could not resolve to a node with the global id of 'item-I_201'." };
  const samples = [
    [{ data: { node: null }, errors: [{ type: "FORBIDDEN", path: ["node"], message: "Resource not accessible by integration" }] }, "gh: Forbidden", "github_permission_denied"],
    [{ data: { node: null }, errors: [missing, { type: "INTERNAL", path: ["node"], message: "Temporarily unavailable" }] }, "gh: Temporarily unavailable", "github_request_rejected"],
    [{ data: { node: null }, errors: [{ ...missing, path: ["node", "fieldValues"] }] }, "gh: Could not resolve field", "github_request_rejected"],
    [{ data: { node: {} }, errors: [missing] }, "gh: Could not resolve field", "github_request_rejected"],
    [{ data: {}, errors: [missing] }, "gh: Could not resolve field", "github_request_rejected"],
    [{ data: { node: null }, errors: [{ type: "INTERNAL", path: ["node"], message: "Temporarily unavailable" }] }, "gh: Temporarily unavailable", "github_request_rejected"],
    [{ data: { node: null }, errors: [missing] }, "gh: HTTP 403: Forbidden", "github_permission_denied"],
    [{ data: { node: null } }, "gh: connection reset", "github_connection_failed"],
  ];
  for (const [body, stderr, error] of samples) {
    repo.updateRemote(remote => { remote.itemFieldsResponse = { body, stderr }; remote.requests = []; });
    const result = repo.worker(event);
    assert.equal(result.status, 1);
    assert.equal(resultJson(result).error, error);
    assert.deepEqual(execute(repo, "show").remote, before, "failed field read cannot acknowledge intent or overwrite canonical evidence");
    assert.deepEqual(mutations(repo), [], "a field-read error cannot start membership repair");
  }
  repo.updateRemote(remote => { delete remote.itemFieldsResponse; remote.deferDispatch = false; });
  execute(repo, "sync");
  assert.deepEqual(JSON.parse(repo.remote().dispatches.at(-1)), event);
  const after = execute(repo, "show").remote;
  assert.equal(after.receipts[event.id].state, "published");
  assert.equal(after.tickets[201].projectItemId, before.tickets[201].projectItemId);
  assert.equal(after.tickets[201].manualConflict, before.tickets[201].manualConflict);
});
