import assert from "node:assert/strict";
import test from "node:test";
import { remoteAncestor, remoteCommit } from "../agent-tracking/evidence.mjs";
import { TrackerError } from "../agent-tracking/github.mjs";

const config = { repository: "example/project" };
const prefix = "repos/example/project";
const missing = () => { throw new TrackerError("github_not_found"); };

for (const code of ["github_permission_denied", "github_connection_failed", "github_request_rejected", "github_not_found"]) {
  test(`comparison fallback preserves ${code} when commit access cannot be established`, () => {
    const github = { request(endpoint) {
      if (endpoint.includes("/compare/")) return missing();
      if (endpoint === prefix && code === "github_not_found") return missing();
      throw new TrackerError(code);
    } };
    assert.throws(() => remoteAncestor(github, config, "old", "new"), { code });
  });
}

test("a missing historical object requires a readable current default commit", () => {
  const requests = [];
  const github = { request(endpoint) {
    requests.push(endpoint);
    if (endpoint.endsWith("/commits/old")) return missing();
    if (endpoint === prefix) return { default_branch: "main" };
    if (endpoint.endsWith("/commits/main")) return { sha: "current" };
    throw new Error(`Unexpected request: ${endpoint}`);
  } };
  assert.throws(() => remoteCommit(github, config, "old", { historical: true }), { code: "revision_unavailable" });
  assert.deepEqual(requests, [`${prefix}/commits/old`, prefix, `${prefix}/commits/main`]);
  requests.length = 0;
  assert.throws(() => remoteCommit(github, config, "old"), { code: "github_not_found" });
  assert.deepEqual(requests, [`${prefix}/commits/old`]);
});

test("an unreadable default commit remains a provider failure", () => {
  const github = { request(endpoint) {
    if (endpoint === prefix) return { default_branch: "main" };
    return missing();
  } };
  assert.throws(() => remoteCommit(github, config, "old", { historical: true }), { code: "github_not_found" });
});
