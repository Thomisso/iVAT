import assert from "node:assert/strict";
import test from "node:test";
import * as evidence from "../ci-pr-evidence.mjs";

test("only unrelated PR label edits suppress verification; missing metadata stays conservative", () => {
  for (const action of ["labeled", "unlabeled"]) {
    assert.equal(evidence.verificationEvent("pull_request", { action, label: { name: "needs-info" } }), false);
    assert.equal(evidence.verificationEvent("pull_request", { action, label: { name: "ci:full" } }), true);
    assert.equal(evidence.verificationEvent("pull_request", { action }), true);
    assert.equal(evidence.verificationEvent("pull_request", { action, label: { name: "" } }), true);
    assert.equal(evidence.verificationEvent("pull_request", { action, label: { name: "CI:FULL" } }), true);
  }
  for (const action of ["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft"]) {
    assert.equal(evidence.verificationEvent("pull_request", { action }), true);
    assert.equal(evidence.verificationEvent("pull_request", { action, label: { name: "" } }), true);
    assert.equal(evidence.verificationEvent("pull_request", { action, label: { name: "CI:FULL" } }), true);
  }
  assert.equal(evidence.verificationEvent("push", {}), true);
});

test("selection CLI suppresses unrelated label work without publishing a new stable-gate approval", async t => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { verificationPlan } = await import("../ci-policy.mjs");
  const directory = mkdtempSync(join(tmpdir(), "ivat-pr-selection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const eventFile = join(directory, "event.json"); const output = join(directory, "output");
  writeFileSync(eventFile, JSON.stringify({ action: "labeled", label: { name: "needs-info" } })); writeFileSync(output, "");
  const plan = verificationPlan({ event: "pull_request", files: ["src/app/page.tsx"] });
  const result = spawnSync(process.execPath, [new URL("../ci-pr-evidence.mjs", import.meta.url).pathname, "select"], { encoding: "utf8", env: { PATH: process.env.PATH, PLAN: JSON.stringify(plan), GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: output } });
  assert.equal(result.status, 0, result.stderr);
  const publication = readFileSync(output, "utf8");
  assert.match(publication, /^run=false$/m);
  assert.match(publication, /^application=false$/m);
  assert.match(publication, /^reuse=$/m);
  // ci:full removal returns an ordinary application draft to fast feedback.
  writeFileSync(eventFile, JSON.stringify({ action: "unlabeled", label: { name: "ci:full" } })); writeFileSync(output, "");
  const draft = verificationPlan({ event: "pull_request", draft: true, files: ["src/app/page.tsx"] });
  const ordinary = spawnSync(process.execPath, [new URL("../ci-pr-evidence.mjs", import.meta.url).pathname, "select"], { encoding: "utf8", env: { PATH: process.env.PATH, PLAN: JSON.stringify(draft), GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: output } });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.match(readFileSync(output, "utf8"), /^run=true$/m);
  assert.match(readFileSync(output, "utf8"), /^common=true$/m);
  assert.match(readFileSync(output, "utf8"), /^application=false$/m);
  // Incomplete event data keeps the full plan selected rather than crashing
  // the later selector after the classifier already chose conservatively.
  writeFileSync(eventFile, "{"); writeFileSync(output, "");
  const unknown = spawnSync(process.execPath, [new URL("../ci-pr-evidence.mjs", import.meta.url).pathname, "select"], { encoding: "utf8", env: { PATH: process.env.PATH, PLAN: JSON.stringify(plan), GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: output } });
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.match(readFileSync(output, "utf8"), /^application=true$/m);
});
