import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { renderRegistry } from "../agent-tracking/state.mjs";
import { trackerFixture, resultJson } from "./support/agent-tracker-fixture.mjs";

const noise = (seed, length) => Array.from({ length: Math.ceil(length / 64) }, (_, index) => createHash("sha256").update(`${seed}:${index}`).digest("hex")).join("").slice(0, length);
const execute = (repo, ...args) => {
  const result = repo.run(...args);
  assert.equal(result.status, 0, result.stderr);
  return resultJson(result);
};

function retainedBacklog(t) {
  const repo = trackerFixture(t);
  repo.now("2026-11-05T12:00:00.000Z");
  assert.equal(repo.setup().status, 0);
  execute(repo, "start", "--run", "parts-owner");
  execute(repo, "claim", "--issue", "201", "--agent", "implementer", "--branch", "feat/ticket");
  const state = execute(repo, "show").remote;
  const original = structuredClone(state.tickets[201]);
  let prior = structuredClone(state);
  for (let number = 202; ; number++) {
    const revision = noise(`revision-${number}`, 40);
    state.tickets[number] = { ...structuredClone(original), number, nodeId: `I_${number}`, projectItemId: `item-I_${number}`,
      title: `Retained implementation ${number}`, url: `https://github.com/example/project/issues/${number}`,
      lastReview: { implementer: "implementer", reviewer: "independent-reviewer", base: noise(`base-${number}`, 40), revision,
        checks: noise(`checks-${number}`, 950), implementationComplete: true, checksStatus: "passed", handoffAt: "2026-11-04T12:00:00.000Z",
        standards: "fail", spec: "fail", outcome: "findings", independence: noise(`independence-${number}`, 400),
        findings: Array.from({ length: 4 }, (_, index) => noise(`finding-${number}-${index}`, 480)), result: "Retained findings require correction" } };
    try { renderRegistry(state); prior = structuredClone(state); }
    catch (error) {
      assert.equal(error.code, "registry_capacity_exceeded");
      const review = state.tickets[number].lastReview;
      for (;;) {
        const index = review.findings.findIndex(value => value.length > 20);
        if (index >= 0) review.findings[index] = review.findings[index].slice(0, -10);
        else review.checks = review.checks.slice(0, -10);
        try { renderRegistry(state); prior = structuredClone(state); break; } catch (error) { assert.equal(error.code, "registry_capacity_exceeded"); }
      }
      break;
    }
  }
  // One retained record crosses the legacy body bound. Restore the last valid
  // canonical snapshot, then use the ordinary durable review command to cross it.
  repo.updateRemote(remote => {
    remote.registry = renderRegistry(prior);
    for (const record of Object.values(prior.tickets).filter(record => record.number !== 201)) {
      remote.items[record.nodeId] = { id: record.projectItemId, values: structuredClone(remote.items.I_201.values) };
    }
    remote.deferDispatch = true;
  });
  const revision = repo.git("rev-parse", "feat/ticket");
  const queued = repo.run("review", "--issue", "201", "--base", revision, "--revision", revision,
    "--checks", noise("new-review", 1000), "--result", noise("new-result", 950));
  assert.equal(resultJson(queued).error, "publication_pending");
  const event = JSON.parse(repo.remote().dispatches.at(-1));
  return { repo, event, before: prior };
}

test("a high-entropy retained backlog publishes immutable parts and acknowledges the same FIFO review", t => {
  const { repo, event, before } = retainedBacklog(t);
  const operatorComments = Array.from({ length: 105 }, (_, index) => ({ id: 20_000 + index, body: `Operator context ${index}` }));
  repo.updateRemote(remote => { remote.registryComments = structuredClone(operatorComments); });
  const result = repo.worker(event);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(execute(repo, "sync").synchronized, true);
  const shown = execute(repo, "show");
  assert.equal(shown.local.pending.length, 0);
  assert.equal(shown.remote.owner.sequence, event.sequence);
  assert.equal(shown.remote.owner.lastEventId, event.id);
  assert.equal(shown.remote.receipts[event.id].state, "published");
  assert.equal(shown.remote.tickets[201].review.checks, event.payload.checks);
  for (const [number, record] of Object.entries(before.tickets).filter(([number]) => number !== "201")) assert.deepEqual(shown.remote.tickets[number], record);
  assert.deepEqual(shown.remote.runHistory, before.runHistory);
  assert.deepEqual(shown.remote.views, before.views);
  for (const [id, receipt] of Object.entries(before.receipts)) assert.deepEqual(shown.remote.receipts[id], receipt);
  for (const [key, value] of Object.entries(before).filter(([key]) => !["owner", "revision", "publishedRevision", "tickets", "receipts"].includes(key))) assert.deepEqual(shown.remote[key], value);
  assert.ok(gzipSync(JSON.stringify(shown.remote)).length > 46_000, "retained evidence exceeds a single base64 comment");
  assert.match(repo.remote().registry, /"registryEncoding":"gzip-parts-v1"/);
  assert.ok(repo.remote().registryComments.length > 0);
  assert.ok(Buffer.byteLength(repo.remote().registry) <= 61_440);
  for (const comment of repo.remote().registryComments) assert.ok(Buffer.byteLength(comment.body) <= 61_440);
  assert.deepEqual(repo.remote().registryComments.slice(0, 105), operatorComments);
});

for (const failure of [
  { name: "before creating a part", match: "POST repos/example/project/issues/99/comments", phase: "before", rootCommitted: false },
  { name: "after creating a part with a lost response", match: "POST repos/example/project/issues/99/comments", phase: "after", completes: true },
  { name: "before publishing the root", match: "PATCH repos/example/project/issues/comments/900", phase: "before", rootCommitted: false },
  { name: "after publishing the root with a lost response", match: "PATCH repos/example/project/issues/comments/900", phase: "after", rootCommitted: true },
  { name: "during part readback", match: "GET repos/example/project/issues/comments/10001", phase: "before", rootCommitted: false },
  { name: "during root readback", match: "GET repos/example/project/issues/99/comments", phase: "before", skip: 3, rootCommitted: true },
  { name: "after root readback with a lost response", match: "GET repos/example/project/issues/99/comments", phase: "after", skip: 3, rootCommitted: true },
  { name: "after the published acknowledgment root", match: "PATCH repos/example/project/issues/comments/900", phase: "after", skip: 1, rootCommitted: true, published: true },
]) test(`the same durable review recovers ${failure.name}`, t => {
  const { repo, event, before } = retainedBacklog(t);
  const originalRoot = repo.remote().registry;
  const originalComments = repo.remote().ticketComments;
  repo.updateRemote(remote => { remote.failure = { match: failure.match, phase: failure.phase, skip: failure.skip ?? 0, remaining: 1 }; });
  const attempted = repo.worker(event);
  assert.equal(attempted.status, failure.completes ? 0 : 1, attempted.stderr);
  const interrupted = execute(repo, "show");
  assert.equal(interrupted.local.pending.length, 1, "only a published receipt consumed by the client clears intent");
  if (!failure.completes) {
    assert.equal(interrupted.remote.owner.sequence, failure.rootCommitted ? event.sequence : before.owner.sequence);
    if (!failure.rootCommitted) assert.equal(repo.remote().registry, originalRoot);
    if (!failure.published) assert.deepEqual(repo.remote().ticketComments, originalComments, "unverified canonical storage cannot begin ticket projection");
  }
  assert.equal(repo.worker(event).status, 0);
  assert.equal(execute(repo, "sync").synchronized, true);
  const shown = execute(repo, "show");
  assert.equal(shown.local.pending.length, 0);
  assert.equal(shown.remote.owner.sequence, event.sequence);
  assert.equal(shown.remote.receipts[event.id].state, "published");
  assert.equal(shown.remote.tickets[201].review.checks, event.payload.checks);
  for (const [number, record] of Object.entries(before.tickets).filter(([number]) => number !== "201")) assert.deepEqual(shown.remote.tickets[number], record);
  const bodies = repo.remote().registryComments.map(comment => comment.body);
  assert.equal(new Set(bodies).size, bodies.length, "ambiguous creation reuses exact parts instead of creating duplicates");
});

const wrap = value => `<!-- ivat-agent-tracker:registry:v1 -->\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
const partWrap = value => `<!-- ivat-agent-tracker:part:v1 -->\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
const valueOf = body => JSON.parse(body.match(/```json\n([\s\S]+)\n```/)[1]);

test("corrupt or unavailable multipart canonical state refuses the worker and preserves durable owned intent", t => {
  const { repo, event } = retainedBacklog(t);
  assert.equal(repo.worker(event).status, 0);
  const valid = repo.remote();
  const cases = [
    ["missing part", "registry_invalid", (root, parts) => { parts.shift(); }],
    ["foreign part", "registry_invalid", (root, parts) => { const part = valueOf(parts[0].body); part.rootCommentId = 999; parts[0].body = partWrap(part); }],
    ["operator comment reference", "registry_invalid", (root, parts) => { parts[0].body = "Operator evidence must remain untouched"; }],
    ["corrupt part", "registry_invalid", (root, parts) => { const part = valueOf(parts[0].body); part.data = "AAAA"; parts[0].body = partWrap(part); }],
    ["duplicate part reference", "registry_invalid", root => { root.parts[1] = root.parts[0]; }],
    ["reordered parts", "registry_invalid", root => { root.parts.reverse(); }],
    ["unknown manifest field", "registry_invalid", root => { root.extra = true; }],
    ["too many parts", "registry_capacity_exceeded", root => { root.parts = Array(257).fill(root.parts[0]); }],
    ["decoded bound", "registry_capacity_exceeded", root => { root.decodedBytes = 4_194_305; }],
    ["compressed bound", "registry_capacity_exceeded", root => { root.compressedBytes = 8_388_609; }],
    ["part bound", "registry_capacity_exceeded", root => { root.parts[0].bytes = 32_769; }],
    ["comment bound", "registry_capacity_exceeded", (_root, parts) => { parts[0].body += "x".repeat(61_440); }],
    ["compressed total mismatch", "registry_invalid", root => { root.compressedBytes--; }],
    ["noncanonical base64", "registry_invalid", (root, parts) => { const part = valueOf(parts[0].body); part.data += "!"; parts[0].body = partWrap(part); }],
    ["duplicate returned part identity", "registry_invalid", (_root, parts) => { parts.push(structuredClone(parts[0])); }],
    ["invalid UTF-8 despite consistent integrity", "registry_invalid", (root, parts) => {
      const decoded = Buffer.from([0xff]);
      const compressed = gzipSync(decoded);
      const sha = bytes => createHash("sha256").update(bytes).digest("hex");
      Object.assign(root, { decodedBytes: 1, sha256: sha(decoded), compressedBytes: compressed.length, compressedSha256: sha(compressed), parts: [{ id: parts[0].id, bytes: compressed.length, sha256: sha(compressed) }] });
      parts[0].body = partWrap({ rootCommentId: 900, snapshotSha256: root.sha256, index: 0, count: 1, sha256: sha(compressed), data: compressed.toString("base64") });
    }],
  ];
  for (const [name, error, corrupt] of cases) {
    repo.updateRemote(remote => {
      remote.registry = valid.registry;
      remote.registryComments = structuredClone(valid.registryComments.filter(comment => valueOf(valid.registry).parts.some(part => part.id === comment.id)));
      const root = valueOf(remote.registry);
      corrupt(root, remote.registryComments);
      remote.registry = wrap(root);
    });
    const before = repo.remote();
    const refused = repo.worker(event);
    assert.equal(refused.status, 1, name);
    assert.equal(resultJson(refused).error, error, name);
    assert.equal(execute(repo, "show", "--local").local.pending.length, 1, name);
    assert.deepEqual(repo.remote(), before, name);
  }
  repo.updateRemote(remote => { remote.registry = valid.registry; remote.registryComments = valid.registryComments; });
  assert.equal(repo.worker(event).status, 0);
  assert.equal(execute(repo, "sync").synchronized, true);
});
