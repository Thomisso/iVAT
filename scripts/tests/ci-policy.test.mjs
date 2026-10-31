import assert from "node:assert/strict";
import test from "node:test";
import { classifyChanges } from "../ci-policy.mjs";

test("only known documentation paths can avoid runtime verification", () => {
  assert.equal(classifyChanges({ event: "pull_request", files: ["README.md", "docs/adr/0015.md"] }), "docs");
  for (const file of ["public/logo.svg", "package-lock.json", "supabase/migrations/new.sql", ".github/workflows/ci.yml", "src/example.md", "docs/runtime.json", "Dockerfile", "unknown"]) {
    assert.equal(classifyChanges({ event: "pull_request", files: ["README.md", file] }), "full", file);
  }
  assert.equal(classifyChanges({ event: "pull_request", draft: true, files: [] }), "full");
  assert.equal(classifyChanges({ event: "push", files: ["README.md"] }), "full");
});

test("draft commits are cheap, ready transitions and ready updates get full checks", () => {
  assert.equal(classifyChanges({ event: "pull_request", draft: true, files: ["src/app/page.tsx"] }), "draft");
  for (const action of ["ready_for_review", "synchronize", "reopened"]) {
    assert.equal(classifyChanges({ event: "pull_request", action, draft: false, files: ["src/app/page.tsx"] }), "full");
  }
  assert.equal(classifyChanges({ event: "push", draft: true, files: [] }), "full");
});

test("stable gate rejects a failed, cancelled, or unexpectedly skipped prerequisite", async () => {
  const { verificationPassed } = await import("../ci-policy.mjs");
  assert.equal(verificationPassed("docs", { quick: "success", full: "skipped" }), true);
  assert.equal(verificationPassed("draft", { quick: "success", full: "skipped" }), true);
  assert.equal(verificationPassed("full", { quick: "success", full: "success" }), true);
  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    assert.equal(verificationPassed("full", { quick: "success", full: result }), false);
    assert.equal(verificationPassed("docs", { quick: result, full: "skipped" }), false);
  }
  assert.equal(verificationPassed(undefined, { quick: "success", full: "skipped" }), false);
});

test("workflows run ready transitions, preserve required names and only cancel obsolete PR runs", async () => {
  const { readFileSync } = await import("node:fs");
  for (const filename of ["ci.yml", "deployment-check.yml"]) {
    const workflow = readFileSync(new URL(`../../.github/workflows/${filename}`, import.meta.url), "utf8");
    assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review, converted_to_draft, labeled, unlabeled\]/);
    assert.match(workflow, /group: \$\{\{ github.workflow \}\}-\$\{\{ github.event.pull_request.number \|\| github.run_id \}\}/);
    assert.match(workflow, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/);
    assert.match(workflow, /branches: \[main\]/);
    assert.match(workflow, /if: always\(\)/);
    assert.match(workflow, /run: node scripts\/ci-policy.mjs gate/);
    assert.match(workflow, /run: node scripts\/ci-policy.mjs\n/);
  }
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /\n  check:\n/);
  assert.match(ci, /\n  e2e:\n/);
  assert.match(ci, /run: npm run test:serial/);
  assert.match(ci, /Stop the acceptance database\n        if: always\(\)/);
  const deployment = readFileSync(new URL("../../.github/workflows/deployment-check.yml", import.meta.url), "utf8");
  assert.match(deployment, /\n  self-hosted:\n/);
  assert.match(deployment, /Stop the disposable runtime\n        if: always\(\)/);
  const release = readFileSync(new URL("../../.github/workflows/prepare-release.yml", import.meta.url), "utf8");
  assert.match(release, /group: rosti-production\n      cancel-in-progress: false/);
});


test("explicit full verification on a draft supplies complete review evidence", () => {
  assert.equal(classifyChanges({ event: "pull_request", draft: true, fullVerification: true, files: ["src/app/page.tsx"] }), "full");
  assert.equal(classifyChanges({ event: "pull_request", draft: true, fullVerification: true, files: ["README.md"] }), "full");
  assert.equal(classifyChanges({ event: "pull_request", draft: true, fullVerification: false, files: ["src/app/page.tsx"] }), "draft");
});
