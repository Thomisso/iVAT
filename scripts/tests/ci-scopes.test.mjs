import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as policy from "../ci-policy.mjs";

test("documentation PRs publish explicit scopes and reasons without infrastructure or runtime work", () => {
  const plan = policy.verificationPlan({ event: "pull_request", files: ["README.md", "docs/ci.md"] });
  assert.deepEqual(plan.scopes, {
    common: false, tracker: false, trackerTransport: false, release: false,
    application: false, http: false, deployment: false,
  });
  assert.equal(plan.profile, "docs");
  assert.equal(plan.reason, "documentation-only");
  assert.equal(plan.reasons.tracker, "tracker-inputs-unchanged");
  assert.equal(plan.reasons.application, "application-inputs-unchanged");
});

test("ordinary application readiness adds the complete application and HTTP scopes, without unrelated infrastructure", () => {
  for (const draft of [true, false]) {
    const plan = policy.verificationPlan({ event: "pull_request", draft, files: ["src/app/page.tsx", "docs/ci.md"] });
    assert.deepEqual(plan.scopes, {
      common: true, tracker: false, trackerTransport: false, release: false,
      application: !draft, http: !draft, deployment: !draft,
    });
    assert.equal(plan.profile, draft ? "draft" : "full");
    assert.equal(plan.reason, draft ? "draft-change" : "ready-change");
    assert.equal(plan.reasons.application, draft ? "draft-awaiting-readiness" : "ready-application-change");
    assert.equal(plan.reasons.deployment, draft ? "draft-awaiting-readiness" : "conservative-ready-deployment");
  }
});

test("uncertain impact, full overrides and broad shared inputs require every scope even on drafts", () => {
  const cases = [
    [{ event: "push", files: ["README.md"] }, "conservative-non-pr"],
    [{ event: "release", files: ["README.md"] }, "conservative-non-pr"],
    [{ fullVerification: true, files: ["README.md"] }, "full-override"],
    [{ files: [] }, "empty-diff"],
    [{}, "incomplete-diff"],
    [{ files: ["README.md"], complete: false }, "incomplete-diff"],
    [{ files: [null] }, "incomplete-diff"],
    [{ files: ["unknown/location"] }, "unknown-input:unknown/location"],
    ...["package.json", "package-lock.json", ".npmrc", ".nvmrc", "next.config.ts", "tsconfig.json", "supabase/config.toml", "supabase/migrations/old.sql", "src/lib/supabase/server.ts", "src/lib/database.types.ts", "src/application/client.ts", "src/proxy.ts", "worker/index.ts", "Dockerfile", "docker-compose.rosti.yml", ".dockerignore", ".env.example", "deploy/db/Dockerfile", "deploy/gateway/kong.yml", "deploy/proxy/default.conf.template"].map(file => [{ files: [file] }, `shared-input:${file}`]),
  ];
  for (const [input, reason] of cases) {
    const plan = policy.verificationPlan({ event: "pull_request", draft: true, ...input });
    assert.deepEqual(plan.scopes, {
      common: true, tracker: true, trackerTransport: true, release: true,
      application: true, http: true, deployment: true,
    }, reason);
    assert.equal(plan.profile, "full");
    assert.equal(plan.reason, reason);
    assert.equal(plan.reasons.tracker, reason);
    assert.equal(plan.reasons.http, reason);
  }
});

test("complete tracker and release dependency sets select infrastructure checks on drafts without starting application stacks", () => {
  const trackerInputs = [
    "scripts/agent-tracker.mjs", "scripts/agent-tracking/publisher.mjs", "scripts/tests/agent-tracker-publication.test.mjs",
    "scripts/tests/support/agent-tracker-fixture.mjs", "scripts/verify-agent-tracker-transport.mjs",
    ".github/agent-tracking.json", ".github/workflows/agent-tracking.yml",
    "postman/mocks/github-agent/default.js", "postman/simulations/github-agent/github-agent.context.yaml",
  ];
  const releaseInputs = [
    "deploy/scripts/release-policy.mjs", "deploy/tests/release-prepare.test.mjs", "deploy/tests/simulation-process.mjs",
    "scripts/write-release-identity.mjs", "scripts/tests/release-identity.test.mjs", ".github/workflows/prepare-release.yml",
    ".github/workflows/daily-backup.yml", "postman/mocks/github-release/default.js", "postman/simulations/release-flow/release-flow.sim.yaml",
    "postman/mocks/rosti-deployment/default.js", "postman/simulations/rosti-deployment/rosti-deployment.context.yaml",
  ];
  const verificationInputs = [".github/workflows/ci.yml", ".github/workflows/deployment-check.yml", "scripts/ci-policy.mjs", "scripts/tests/ci-policy.test.mjs", "scripts/tests/ci-scopes.test.mjs"];
  for (const [inputs, tracker, release, reasonPrefix] of [[trackerInputs, true, false, "tracker-input"], [releaseInputs, false, true, "release-input"], [verificationInputs, true, true, "verification-input"]]) {
    for (const file of inputs) {
      const plan = policy.verificationPlan({ event: "pull_request", draft: true, files: ["docs/ci.md", file] });
      assert.deepEqual(plan.scopes, { common: true, tracker, trackerTransport: tracker, release, application: false, http: false, deployment: false }, file);
      assert.equal(plan.reason, "draft-change", file);
      if (tracker) assert.equal(plan.reasons.tracker, `${reasonPrefix}:${file}`);
      if (release) assert.equal(plan.reasons.release, `${reasonPrefix}:${file}`);
    }
  }
  const mixed = policy.verificationPlan({ event: "pull_request", draft: true, files: [trackerInputs[0], releaseInputs[0], "src/app/page.tsx"] });
  assert.deepEqual(mixed.scopes, { common: true, tracker: true, trackerTransport: true, release: true, application: false, http: false, deployment: false });
});

function repository(t, initial) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ivat-ci-scope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
  const write = (file, content) => { mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); writeFileSync(path.join(directory, file), content); };
  git("init", "-b", "main");
  git("config", "user.name", "CI policy fixture");
  git("config", "user.email", "ci@example.test");
  for (const [file, content] of Object.entries(initial)) write(file, content);
  const commit = message => { git("add", "-A"); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  const base = commit("Base");
  const classify = (overrides = {}, rawEvent) => {
    const event = rawEvent === undefined ? { pull_request: { base: { sha: base }, head: { sha: git("rev-parse", "HEAD") }, draft: true, labels: [], ...overrides } } : rawEvent;
    write("event.json", JSON.stringify(event));
    write("output", "");
    const result = spawnSync(process.execPath, [new URL("../ci-policy.mjs", import.meta.url).pathname], {
      cwd: directory, encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: path.join(directory, "event.json"), GITHUB_OUTPUT: path.join(directory, "output") },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = Object.fromEntries(readFileSync(path.join(directory, "output"), "utf8").trim().split("\n").map(line => { const split = line.indexOf("="); return [line.slice(0, split), line.slice(split + 1)]; }));
    return { output, plan: output.plan && JSON.parse(output.plan), log: result.stdout };
  };
  return { directory, git, write, commit, classify, base };
}

test("classification CLI publishes scopes and reasons from the whole PR rather than its final documentation commit", t => {
  const repo = repository(t, { "README.md": "Base docs", "src/app/page.tsx": "Base app" });
  repo.write("src/app/page.tsx", "Changed app"); repo.commit("Application change");
  repo.write("README.md", "Final documentation"); repo.commit("Documentation change");
  const { output, plan, log } = repo.classify();
  assert.equal(plan?.profile, "draft");
  assert.equal(plan.scopes.common, true);
  assert.equal(plan.scopes.tracker, false);
  assert.equal(output.common, "true");
  assert.equal(output.application, "false");
  assert.match(log, /draft-awaiting-readiness/);
});

test("renames and deletions retain old dependency paths, including unusual filenames", t => {
  const repo = repository(t, { "scripts/agent-tracker.mjs": "Unchanged moved content", "deploy/scripts/old.mjs": "Removed release command", "docs/odd\nname.md": "Old docs" });
  repo.git("mv", "scripts/agent-tracker.mjs", "docs/moved.md");
  repo.git("rm", "deploy/scripts/old.mjs");
  repo.write("docs/odd\nname.md", "Changed docs");
  repo.commit("Rename tracker command and delete release input");
  const { plan } = repo.classify();
  assert.deepEqual(plan.scopes, { common: true, tracker: true, trackerTransport: true, release: true, application: false, http: false, deployment: false });
  assert.equal(plan.reasons.tracker, "tracker-input:scripts/agent-tracker.mjs");
  assert.equal(plan.reasons.release, "release-input:deploy/scripts/old.mjs");
});

test("classification CLI fails closed for an unavailable base or missing head, and for an empty complete diff", t => {
  const repo = repository(t, { "README.md": "Only docs" });
  for (const [overrides, reason] of [[{ base: { sha: "a".repeat(40) } }, "incomplete-diff"], [{ head: {} }, "incomplete-diff"], [{}, "empty-diff"]]) {
    const { plan } = repo.classify(overrides);
    assert.equal(plan.profile, "full");
    assert.equal(plan.reason, reason);
    assert.equal(plan.scopes.trackerTransport, true);
    assert.equal(plan.scopes.http, true);
  }
});

test("stable scoped gates distinguish explicit inapplicability from failed or absent required work", () => {
  const full = policy.verificationPlan({ event: "pull_request", fullVerification: true, files: ["README.md"] });
  const docs = policy.verificationPlan({ event: "pull_request", files: ["README.md"] });
  const checks = { policy: "success", common: "success", tracker: "success", trackerTransport: "success", release: "success", application: "success" };
  const gateCases = [
    ["check", checks, ["policy", "common", "tracker", "trackerTransport", "release", "application"]],
    ["e2e", { policy: "success", common: "success", http: "success" }, ["policy", "common", "http"]],
    ["self-hosted", { policy: "success", deployment: "success" }, ["policy", "deployment"]],
  ];
  for (const [gate, results, scopes] of gateCases) {
    assert.equal(policy.verificationPassed(full, gate, results), true, gate);
    const skipped = Object.fromEntries(scopes.map(scope => [scope, scope === "policy" ? "success" : "skipped"]));
    assert.equal(policy.verificationPassed(docs, gate, skipped), true, gate);
    for (const scope of scopes) {
      for (const outcome of ["failure", "cancelled", "skipped", undefined]) {
        assert.equal(policy.verificationPassed(full, gate, { ...results, [scope]: outcome }), false, `${gate}/${scope}/${outcome}`);
      }
      if (scope !== "policy") {
        for (const outcome of ["success", "failure", "cancelled", undefined]) {
          assert.equal(policy.verificationPassed(docs, gate, { ...skipped, [scope]: outcome }), false, `${gate}/inapplicable/${scope}/${outcome}`);
        }
      }
    }
  }
  for (const plan of [undefined, {}, { ...full, version: 2 }, { ...full, scopes: {} }, { ...full, reasons: {} }]) {
    assert.equal(policy.verificationPassed(plan, "check", checks), false);
  }
  assert.equal(policy.verificationPassed(full, "unknown", checks), false);
});

test("gate CLI consumes the published plan and explains required versus inapplicable results", () => {
  const plan = policy.verificationPlan({ event: "pull_request", draft: true, files: ["scripts/agent-tracker.mjs"] });
  const results = { policy: "success", common: "success", tracker: "success", trackerTransport: "success", release: "skipped", application: "skipped" };
  const run = (overrides = {}) => spawnSync(process.execPath, [new URL("../ci-policy.mjs", import.meta.url).pathname, "gate"], {
    encoding: "utf8", env: { PATH: process.env.PATH, PLAN: JSON.stringify(plan), GATE: "check", RESULTS: JSON.stringify(results), ...overrides },
  });
  const passed = run();
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /tracker: required.*tracker-input:scripts\/agent-tracker.mjs/);
  assert.match(passed.stdout, /release: not applicable.*release-inputs-unchanged/);
  for (const overrides of [{ PLAN: "[" }, { PLAN: "{}" }, { PLAN: "" }, { RESULTS: "[" }, { RESULTS: "[]" }, { RESULTS: "null" }, { GATE: "unknown" }, { RESULTS: JSON.stringify({ ...results, trackerTransport: "skipped" }) }]) {
    assert.equal(run(overrides).status, 1, JSON.stringify(overrides));
  }
});

test("malformed PR event metadata is incomplete impact rather than a cheap selection or crashed classifier", t => {
  const repo = repository(t, { "README.md": "Docs" });
  repo.write("README.md", "Updated docs"); repo.commit("Documentation");
  for (const [overrides, rawEvent] of [[{}, null], [{ labels: {} }], [{ draft: "true" }], [{ labels: [{ name: 42 }] }]]) {
    const { plan } = repo.classify(overrides, rawEvent);
    assert.equal(plan.reason, "incomplete-diff");
    assert.equal(plan.scopes.application, true);
    assert.equal(plan.scopes.tracker, true);
  }
});
