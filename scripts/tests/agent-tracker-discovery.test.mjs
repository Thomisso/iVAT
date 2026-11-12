import assert from "node:assert/strict";
import test from "node:test";
import { trackerFixture, resultJson } from "./support/agent-tracker-fixture.mjs";

const specificationBody = "## Problem Statement\nNeed\n## Solution\nApproach\n## User Stories\nStory";
const issue = (number, extra = {}) => ({ id: `I_${number}`, number, title: `Issue ${number}`, url: `https://github.com/example/project/issues/${number}`, repository: { nameWithOwner: "example/project" }, body: "", state: "OPEN", parent: null, subIssues: { totalCount: 0 }, labels: ["ready-for-agent"], ...extra });

function execute(repo, ...args) {
  const result = repo.run(...args);
  assert.equal(result.status, 0, result.stderr);
  return resultJson(result);
}

function fixture(t) {
  const primary = trackerFixture(t);
  assert.equal(primary.setup().status, 0);
  return primary.linked();
}

function storeSnapshot(repo, snapshot) {
  repo.updateRemote(remote => { remote.registry = `<!-- ivat-agent-tracker:registry:v1 -->\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n`; });
}

test("discovery promotes the same unclaimed issue after its body becomes a specification", t => {
  const repo = fixture(t);
  repo.updateRemote(remote => { remote.issues = { 201: issue(201) }; });
  execute(repo, "discover");
  const before = execute(repo, "show").remote;
  assert.equal(before.tickets[201].role, "implementation");
  assert.equal(before.tickets[201].status, "ready");

  repo.updateRemote(remote => { remote.issues[201].body = specificationBody; });
  execute(repo, "discover");
  const after = execute(repo, "show").remote;
  const promoted = after.tickets[201];
  assert.equal(promoted.role, "specification");
  assert.equal(promoted.status, null);
  assert.equal(promoted.activity, "inactive");
  assert.equal(promoted.runId, null);
  assert.equal(promoted.agent, null);
  assert.equal(after.owner, null);
  assert.equal(after.generation, 0);
  assert.equal(after.schemaVersion, 1);
  for (const key of ["number", "nodeId", "url", "repository", "projectItemId"]) assert.equal(promoted[key], before.tickets[201][key]);
  assert.deepEqual(Object.keys(after.tickets), ["201"]);
  assert.equal(repo.remote().items.I_201.values.status, null);
  assert.match(repo.remote().ticketComments[0].body, /Specification context/);
  execute(repo, "discover");
  assert.deepEqual(execute(repo, "show").remote.tickets, after.tickets);
  assert.equal(repo.remote().ticketComments.length, 1);
  assert.deepEqual(Object.keys(repo.remote().items), ["I_201"]);
});

test("discovery promotes an existing native parent after both issues leave the ready label", t => {
  const repo = fixture(t);
  repo.updateRemote(remote => { remote.issues = { 201: issue(201), 202: issue(202) }; });
  execute(repo, "discover");
  const before = execute(repo, "show").remote.tickets;
  assert.equal(before[201].role, "implementation");

  repo.updateRemote(remote => {
    remote.issues[201].labels = [];
    remote.issues[202].labels = [];
    remote.issues[202].parent = issue(201);
  });
  execute(repo, "discover");
  const after = execute(repo, "show").remote.tickets;
  assert.equal(after[201].role, "specification");
  assert.equal(after[201].status, null);
  assert.equal(after[201].activity, "inactive");
  assert.equal(after[201].projectItemId, before[201].projectItemId);
  assert.deepEqual(after[202], { ...before[202], parent: 201, parentRepository: "example/project", parentSource: "native" });
  execute(repo, "discover");
  assert.deepEqual(execute(repo, "show").remote.tickets, after);
});

test("native children promote ready issues while ordinary and incomplete bodies remain implementation", t => {
  const repo = fixture(t);
  repo.updateRemote(remote => { remote.issues = { 201: issue(201), 202: issue(202), 203: issue(203), 204: issue(204) }; });
  execute(repo, "discover");
  const before = execute(repo, "show").remote.tickets;
  repo.updateRemote(remote => {
    remote.issues[201].subIssues.totalCount = 1;
    remote.issues[201].parent = issue(300);
    remote.issues[202].parent = issue(201);
    remote.issues[203].body = "## Problem Statement\nNeed\n## Solution\nApproach";
    remote.issues[204].body = "Implement Problem Statement, Solution and User Stories headings";
  });
  execute(repo, "discover");
  const after = execute(repo, "show").remote.tickets;
  assert.equal(after[201].role, "specification");
  assert.equal(after[201].status, null);
  assert.equal(after[201].activity, "inactive");
  assert.equal(after[201].parent, 300);
  assert.equal(after[201].parentRepository, "example/project");
  assert.equal(after[201].parentSource, "native");
  assert.equal(after[202].parent, 201);
  assert.equal(after[202].role, "implementation");
  assert.deepEqual(after[203], before[203]);
  assert.deepEqual(after[204], before[204]);
  execute(repo, "discover");
  assert.deepEqual(execute(repo, "show").remote.tickets, after);
});

test("conversion clears only passive dependency blockage from an unclaimed specification", t => {
  const repo = fixture(t);
  repo.updateRemote(remote => { remote.issues = { 201: issue(201, { blockers: [{ number: 199, state: "open" }] }) }; });
  execute(repo, "discover");
  const before = execute(repo, "show").remote.tickets[201];
  assert.equal(before.status, "blocked");
  assert.equal(before.blockage.kind, "dependency");
  repo.updateRemote(remote => { remote.issues[201].body = specificationBody; });
  execute(repo, "discover");
  const after = execute(repo, "show").remote.tickets[201];
  assert.equal(after.role, "specification");
  assert.equal(after.status, null);
  assert.equal(after.blockage, null);
  assert.equal(after.projectItemId, before.projectItemId);
});

test("specification conversion preserves claimed work and stopped historical ownership", t => {
  const repo = fixture(t);
  repo.updateRemote(remote => { remote.issues = { 201: issue(201) }; });
  execute(repo, "discover");
  execute(repo, "start", "--run", "preserved-run");
  execute(repo, "claim", "--issue", "201", "--agent", "worker", "--branch", "feat/ticket");
  const active = execute(repo, "show").remote.tickets[201];
  repo.updateRemote(remote => { remote.issues[201].body = specificationBody; remote.issues[201].subIssues.totalCount = 1; });
  execute(repo, "discover");
  assert.deepEqual(execute(repo, "show").remote.tickets[201], active);
  execute(repo, "stop", "--reason", "Preserve stopped implementation history");
  const stopped = execute(repo, "show").remote;
  assert.equal(stopped.tickets[201].activity, "inactive");
  assert.equal(stopped.tickets[201].runId, "preserved-run");
  execute(repo, "discover");
  const after = execute(repo, "show").remote;
  assert.deepEqual(after.tickets[201], stopped.tickets[201]);
  assert.deepEqual(after.runHistory, stopped.runHistory);
});

test("discovery does not reclassify implementation records carrying execution or historical evidence", t => {
  const repo = fixture(t);
  const at = "2026-11-04T12:00:00.000Z";
  const protectedRecords = [
    { account: "maintainer" }, { agent: "worker" }, { reviewer: "reviewer" }, { branch: "feat/ticket" },
    { workingRevision: "a".repeat(40) }, { pullRequest: "https://github.com/example/project/pull/300" },
    { generation: 1 }, { review: { outcome: "clean" } }, { lastReview: { outcome: "findings" } },
    { integration: { commit: "a".repeat(40) } }, { integrationContext: { specification: 200, branch: "integration/spec" } },
    { final: { revision: "a".repeat(40) } }, { delivery: { current: false } }, { cancellation: { reason: "Cancelled" } },
    { reversal: { reason: "Reversed" } }, { recoveryEvidence: { source: "restart", observedAt: at, unverified: [] } },
    { activityEpisode: { role: "implementer", state: "stopped", startedAt: at, inactiveAt: at } },
    { activityObservation: { observedAt: at } }, { activityAt: at }, { activityPublishedAt: at },
    { lastBlockage: { resolution: "Resolved" } }, { dependencies: { ready: true } }, { futureHistory: { evidence: "Retain" } },
    ...["implementing", "review", "integrated", "done", "cancelled"].map(status => ({ status })),
    { status: "blocked", blockage: { kind: "obstacle", resumePhase: "ready" } },
  ];
  repo.updateRemote(remote => { remote.issues = Object.fromEntries(protectedRecords.map((_, index) => [210 + index, issue(210 + index)])); });
  execute(repo, "discover");
  const snapshot = execute(repo, "show").remote;
  protectedRecords.forEach((evidence, index) => Object.assign(snapshot.tickets[210 + index], evidence));
  // Seed retained canonical evidence awaiting projection, rather than an
  // unsupported manual Project edit of the previously acknowledged values.
  snapshot.revision++;
  storeSnapshot(repo, snapshot);
  repo.updateRemote(remote => { for (const record of Object.values(remote.issues)) record.body = specificationBody; });
  execute(repo, "discover");
  assert.deepEqual(execute(repo, "show").remote.tickets, snapshot.tickets);
});

test("native foreign parent promotion retains qualified identity beside the same local issue number", t => {
  const repo = fixture(t);
  const foreign = issue(200, { id: "I_foreign_200", repository: { nameWithOwner: "other/repository" }, url: "https://github.com/other/repository/issues/200" });
  repo.updateRemote(remote => { remote.issues = { 200: issue(200), 202: issue(202) }; remote.foreignIssues = { "other/repository#200": foreign }; });
  execute(repo, "discover");
  const before = execute(repo, "show").remote;
  const local = before.tickets[200];
  // A retained qualified passive record must be promoted without replacing
  // either repository's issue identity or allocating another context record.
  before.tickets["other/repository#200"] = { ...local, nodeId: foreign.id, repository: "other/repository", url: foreign.url, projectItemId: undefined };
  storeSnapshot(repo, before);
  repo.updateRemote(remote => { remote.issues[202].parent = foreign; });
  execute(repo, "discover");
  const after = execute(repo, "show").remote.tickets;
  assert.deepEqual(after[200], local);
  assert.equal(after[202].parent, 200);
  assert.equal(after[202].parentRepository, "other/repository");
  assert.equal(after[202].parentSource, "native");
  assert.equal(after["other/repository#200"].role, "specification");
  assert.equal(after["other/repository#200"].status, null);
  assert.equal(after["other/repository#200"].activity, "inactive");
  assert.equal(after["other/repository#200"].nodeId, "I_foreign_200");
  assert.equal(after["other/repository#200"].url, foreign.url);
  assert.deepEqual(after["other/repository#200"].summary, { scope: "context_only", repository: "other/repository" });
  assert.deepEqual(Object.keys(after).sort(), ["200", "202", "other/repository#200"]);
  assert.deepEqual(Object.keys(repo.remote().items).sort(), ["I_200", "I_202", "I_foreign_200"]);
  execute(repo, "discover");
  assert.deepEqual(execute(repo, "show").remote.tickets, after);
});
