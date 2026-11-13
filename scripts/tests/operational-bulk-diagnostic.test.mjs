import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { diagnosticSelection, assertDiagnosticInventory } from "../operational-bulk-diagnostic.mjs";
import { verificationPlan, verificationPassed } from "../ci-policy.mjs";

const event = { repository: { full_name: "Thomisso/iVAT" }, pull_request: { head: { ref: "fix/operational-post-cleanup-catalog-344", repo: { full_name: "Thomisso/iVAT" } }, labels: [{ name: "ci:full" }] } };
const environment = { GITHUB_EVENT_NAME: "pull_request", GITHUB_HEAD_REF: "fix/operational-post-cleanup-catalog-344", IVAT_OPERATIONAL_DIAGNOSTIC_MODE: "post_cleanup_catalog_344", PR_REUSE: "old-full-proof" };

test("only the exact owned opt-in PR selects the diagnostic subset and forbids full-proof reuse", () => {
  assert.deepEqual(diagnosticSelection(event, environment), { diagnostic: true, reuse: "" });
  for (const [input, env] of [
    [event, { ...environment, GITHUB_EVENT_NAME: "push" }],
    [event, { ...environment, IVAT_OPERATIONAL_DIAGNOSTIC_MODE: "" }],
    [event, { ...environment, GITHUB_HEAD_REF: "another" }],
    [{ ...event, pull_request: { ...event.pull_request, labels: [] } }, environment],
    [{ ...event, pull_request: { ...event.pull_request, head: { ...event.pull_request.head, repo: { full_name: "foreign/iVAT" } } } }, environment],
    [{}, environment],
  ]) assert.deepEqual(diagnosticSelection(input, env), { diagnostic: false, reuse: "old-full-proof" });
});

test("focused success cannot satisfy application verification or publish complete PR evidence", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const full = workflow.split("\n  full:\n")[1].split(/\n  [a-z-]+:\n/)[0];
  const diagnostic = workflow.split("\n  operational-bulk-diagnostic:\n")[1];
  assert.match(full, /outputs\.application == 'true' && needs\.profile\.outputs\.diagnostic != 'true'/);
  assert.ok(diagnostic);
  assert.match(diagnostic, /name: Operational bulk diagnostic \(89 cases; no full verification\)/);
  assert.match(diagnostic, /if: needs\.profile\.outputs\.diagnostic == 'true'/);
  assert.match(diagnostic, /IVAT_POST_CLEANUP_CATALOG: "1"\n\s+IVAT_OPERATIONAL_DIAGNOSTIC_MODE: post_cleanup_catalog_344/);
  const gate = workflow.split("\n  check:\n")[1].split("\n  e2e:\n")[0];
  assert.match(gate, /"application": "\$\{\{ needs\.full\.result \}\}"/);
  assert.doesNotMatch(gate, /operational-bulk-diagnostic/);
  assert.match(workflow.split("\n  pr-evidence:\n")[1], /needs\.check\.result == 'success'/);
  const plan = verificationPlan({ event: "pull_request", draft: true, fullVerification: true, files: ["tests/operational-email-alerts.test.ts"] });
  assert.equal(verificationPassed(plan, "check", { policy: "success", common: "success", tracker: "success", trackerTransport: "success", release: "success", application: "skipped" }), false);
});

test("actual selector CLI and unchanged gate fail closed when only the diagnostic passes", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ivat-diagnostic-policy-"));
  try {
    const input = path.join(directory, "event.json"), output = path.join(directory, "outputs");
    writeFileSync(input, JSON.stringify(event));
    const selection = spawnSync(process.execPath, [new URL("../operational-bulk-diagnostic.mjs", import.meta.url).pathname], {
      env: { ...process.env, ...environment, GITHUB_EVENT_PATH: input, GITHUB_OUTPUT: output }, encoding: "utf8",
    });
    assert.equal(selection.status, 0); assert.equal(readFileSync(output, "utf8"), "diagnostic=true\nreuse=\n");
    const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const condition = id => workflow.split(`\n  ${id}:\n`)[1].match(/^    if: (.+)$/m)[1];
    for (const focused of [true, false]) {
      const needs = { profile: { outputs: { application: "true", diagnostic: String(focused) } } };
      assert.equal(Function("needs", `return ${condition("full")}`)(needs), !focused);
      assert.equal(Function("needs", `return ${condition("operational-bulk-diagnostic")}`)(needs), focused);
    }
    const plan = verificationPlan({ event: "pull_request", draft: true, fullVerification: true, files: ["tests/operational-email-alerts.test.ts"] });
    const gate = spawnSync(process.execPath, [new URL("../ci-policy.mjs", import.meta.url).pathname, "gate"], {
      env: { PATH: process.env.PATH, PLAN: JSON.stringify(plan), PR_REUSE: "", GATE: "check", RESULTS: JSON.stringify({ policy: "success", common: "success", tracker: "success", trackerTransport: "success", release: "success", application: "skipped" }) }, encoding: "utf8",
    });
    assert.equal(gate.status, 1); assert.match(gate.stdout, /application: required.*result=skipped/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the installed runner inventory must prove one file, all 89 cases and target 84 before startup", () => {
  const file = { file: "/tmp/owned/tests/operational-email-alerts.test.ts" };
  const cases = Array.from({ length: 89 }, () => ({ ...file, name: "other" }));
  cases[83].name = "splits 1001 new Documents in a Company with an active incident without restarting that incident's grace";
  assert.doesNotThrow(() => assertDiagnosticInventory([file], cases));
  for (const [files, rows] of [[[file, file], cases], [[file], cases.slice(1)], [[file], [...cases].reverse()], [[{ file: "/tmp/foreign.test.ts" }], cases]]) {
    assert.throws(() => assertDiagnosticInventory(files, rows), /Diagnostic selection/);
  }
});
