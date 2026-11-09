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


test("all financial application shards and the production HTTP suite keep independent stacks and required gates", async () => {
  const { readFileSync } = await import("node:fs");
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  for (const name of ["full", "acceptance"]) {
    const job = ci.split(`\n  ${name}:\n`)[1].split(/\n  [a-z-]+:\n/)[0];
    if (name === "full") {
      assert.match(job, /fail-fast: false/);
      assert.match(job, /shard: \[1, 2, 3\]/);
      assert.match(job, /--shard=\$\{\{ matrix.shard \}\}\/3/);
    } else {
      assert.doesNotMatch(job, /matrix:/);
      assert.match(job, /run: npm run test:http/);
    }
    assert.match(job, /runs-on: ubuntu-latest/);
    assert.match(job, /if: always\(\)/);
    assert.match(job, /npm run db:stop -- --no-backup/);
    // Supabase's fixed ports overlap Linux's automatic port allocation range.
    // Reserve them before downloads or ephemeral test listeners can take them.
    assert.ok(job.indexOf("Reserve Supabase ports before network setup") < job.indexOf("actions/checkout@"));
    assert.match(job, /reserved=\$\(sysctl -n net\.ipv4\.ip_local_reserved_ports\)/);
    const reservation = job.match(/net\.ipv4\.ip_local_reserved_ports=\$\{reserved:\+\$reserved,\}(\d+)-(\d+)/);
    assert.ok(reservation, "keep existing reservations when adding the Supabase range");
    const config = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf8");
    const ports = [...config.matchAll(/^(?:port|shadow_port|smtp_port|pop3_port) = (\d+)/gm)].map(match => Number(match[1]));
    for (const port of ports) {
      assert.ok(port >= Number(reservation[1]) && port <= Number(reservation[2]), `Supabase port ${port} must be reserved`);
    }
  }
  assert.match(ci, /FULL_RESULT: \$\{\{ needs.full.result \}\}/);
  assert.match(ci, /FULL_RESULT: \$\{\{ needs.acceptance.result \}\}/);
  assert.match(ci, /name: http-acceptance-logs/);
  assert.doesNotMatch(ci, /playwright|chromium|agent-browser|browser_eval/i);
  assert.match(ci, /if: failure\(\) && steps\.supabase\.outcome == 'failure'/);
  assert.match(ci, /sudo ss -tanp/);
});

// Read the configured execution graph without depending on job identifiers.
// These workflows use one-line needs (a scalar or inline list).
async function ciJobs() {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  return [...source.split("\njobs:\n")[1].matchAll(/^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:|$(?![\s\S]))/gm)].map(([, id, body]) => {
    const needs = body.match(/^    needs: (.+)$/m)?.[1] ?? "";
    return { id, body, needs: needs.replace(/[\[\] ]/g, "").split(",").filter(Boolean) };
  });
}

function dependsOn(jobs, job, prerequisite) {
  return job.needs.some(id => id === prerequisite.id || dependsOn(jobs, jobs.find(candidate => candidate.id === id), prerequisite));
}

test("long verification branches start independently after fast policy selection", async () => {
  const jobs = await ciJobs();
  const classifier = jobs.find(job => job.body.includes("run: node scripts/ci-policy.mjs\n"));
  const owners = ["npm run test:agent-tracker", "deploy/tests/release-prepare.test.mjs", "npm run test:serial", "npm run test:http"].map(command => {
    const matches = jobs.filter(job => job.body.includes(command));
    assert.equal(matches.length, 1, `retain the verification branch for ${command}`);
    return matches[0];
  });
  assert.equal(new Set(owners.map(job => job.id)).size, 4);
  for (const job of owners) {
    assert.equal(dependsOn(jobs, job, classifier), true, `${job.id} waits for fast policy selection`);
    for (const other of owners.filter(candidate => candidate !== job)) {
      assert.equal(dependsOn(jobs, job, other), false, `${job.id} must not wait for ${other.id}`);
    }
  }
});

function fullExecutions(jobs, command) {
  return jobs.flatMap(job => {
    if (job.body.match(/^    if: .*outputs\.profile == 'draft'/m)) return [];
    const shards = job.body.match(/^        shard: \[(.+)\]$/m)?.[1].split(",").map(Number) ?? [undefined];
    const steps = job.body.split(/(?=^      - )/m).slice(1);
    return steps.flatMap(step => {
      if (!step.includes(command) || step.match(/^        if: .*outputs\.profile == 'draft'/m)) return [];
      const onlyShard = step.match(/^        if: matrix\.shard == (\d+)$/m)?.[1];
      return shards.filter(shard => !onlyShard || shard === Number(onlyShard)).map(shard => `${job.id}${shard ? ` (${shard})` : ""}`);
    });
  });
}

test("full verification executes shared checks once and HTTP owns the equivalent application build", async () => {
  const jobs = await ciJobs();
  for (const command of [
    "npm install --package-lock-only --ignore-scripts",
    "scripts/tests/release-identity.test.mjs",
    "deploy/tests/release-prepare.test.mjs",
    "deploy/tests/release-host.test.mjs",
    "deploy/tests/release-connect.test.mjs",
    "deploy/tests/release-runtime.test.mjs",
    "node scripts/verify-agent-tracker-transport.mjs",
    "npm run db:types",
    "npm run typecheck",
    "npm run lint",
  ]) {
    assert.equal(fullExecutions(jobs, command).length, 1, `${command} must have one execution owner`);
  }
  assert.deepEqual(fullExecutions(jobs, "npm run build"), [], "the production HTTP runner supplies the equivalent build");
  assert.equal(fullExecutions(jobs, "npm run test:http").length, 1);
  const { readFileSync } = await import("node:fs");
  const http = readFileSync(new URL("../e2e.mjs", import.meta.url), "utf8");
  assert.match(http, /Build production application.*command\("npm", \["run", "build"\]/);
  const deployment = readFileSync(new URL("../../.github/workflows/deployment-check.yml", import.meta.url), "utf8");
  assert.match(deployment, /run: docker compose .* build/);
});

test("stable gates require every selected parallel result, including cheap code checks", async () => {
  const { verificationPassed } = await import("../ci-policy.mjs");
  const full = { quick: ["success", "success"], common: "success", full: "success" };
  assert.equal(verificationPassed("full", full), true);
  assert.equal(verificationPassed("draft", { ...full, full: "skipped" }), true);
  assert.equal(verificationPassed("docs", { ...full, common: "skipped", full: "skipped" }), true);
  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    assert.equal(verificationPassed("full", { ...full, quick: ["success", result] }), false);
    assert.equal(verificationPassed("full", { ...full, common: result }), false);
    assert.equal(verificationPassed("draft", { ...full, common: result, full: "skipped" }), false);
  }
  assert.equal(verificationPassed("full", { ...full, quick: [] }), false);
  assert.equal(verificationPassed("docs", { ...full, common: "success", full: "skipped" }), false);
});

test("configured stable gates reject every failed, cancelled, missing or skipped selected job through the CLI", async () => {
  const { spawnSync } = await import("node:child_process");
  const jobs = await ciJobs();
  const gates = jobs.filter(job => job.body.includes("run: node scripts/ci-policy.mjs gate"));
  const covered = new Set();
  for (const gate of gates) {
    const environment = Object.fromEntries([...gate.body.matchAll(/^          ([A-Z_]+): (.+)$/gm)].map(([, key, value]) => [key, value.replace(/^'|'$/g, "")]));
    const references = [...new Set(Object.values(environment).flatMap(value => [...value.matchAll(/needs\.([a-z-]+)\.result/g)].map(match => match[1])))];
    for (const reference of references) {
      assert.ok(gate.needs.includes(reference), `${gate.id} must await its published prerequisite ${reference}`);
      covered.add(reference);
    }
    const run = (profile, changes = {}) => {
      const results = Object.fromEntries(jobs.map(job => [job.id,
        (/^    if: needs\.profile\.outputs\.profile == 'full'$/m.test(job.body) && profile !== "full")
        || (/^    if: needs\.profile\.outputs\.profile != 'docs'$/m.test(job.body) && profile === "docs") ? "skipped" : "success",
      ]));
      Object.assign(results, changes);
      const env = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, value
        .replace(/\$\{\{ needs\.[a-z-]+\.outputs\.profile \}\}/g, profile)
        .replace(/\$\{\{ needs\.([a-z-]+)\.result \}\}/g, (_, id) => results[id] ?? ""),
      ]));
      return spawnSync(process.execPath, [new URL("../ci-policy.mjs", import.meta.url).pathname, "gate"], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
    };
    for (const profile of ["docs", "draft", "full"]) {
      const result = run(profile);
      assert.equal(result.status, 0, `${gate.id}/${profile}: ${result.stderr}`);
    }
    for (const reference of references) {
      for (const outcome of ["failure", "cancelled", "skipped", undefined]) {
        const result = run("full", { [reference]: outcome });
        assert.equal(result.status, 1, `${gate.id} must refuse ${reference}=${outcome}`);
      }
    }
  }
  for (const job of jobs.filter(job => !gates.includes(job))) {
    assert.ok(covered.has(job.id), `${job.id} must contribute actual result evidence to a stable gate`);
  }
});

test("the gate CLI refuses incomplete or malformed parallel-result publication", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const publication of ["[", "[]", "null", "{}", '\"success\"']) {
    const result = spawnSync(process.execPath, [new URL("../ci-policy.mjs", import.meta.url).pathname, "gate"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, PROFILE: "full", QUICK_RESULTS: publication, COMMON_RESULT: "success", FULL_RESULT: "success" },
    });
    assert.equal(result.status, 1, `invalid parallel results: ${publication}`);
  }
});
