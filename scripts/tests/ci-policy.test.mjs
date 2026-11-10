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

test("workflows run ready transitions, preserve required names and only cancel obsolete PR runs", async () => {
  const { readFileSync } = await import("node:fs");
  for (const filename of ["ci.yml", "deployment-check.yml"]) {
    const workflow = readFileSync(new URL(`../../.github/workflows/${filename}`, import.meta.url), "utf8");
    assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review, converted_to_draft, labeled, unlabeled\]/);
    const evaluate = (template, github) => template.replace(/\$\{\{ (.*?) \}\}/g, (_, expression) => String(Function("github", `return (${expression})`)(github)));
    const concurrency = workflow.split("concurrency:\n")[1].split("\njobs:")[0];
    const group = concurrency.match(/^  group: (.+)$/m)[1];
    const cancellation = concurrency.match(/^  cancel-in-progress: (.+)$/m)[1];
    const ready = { workflow: filename, event_name: "pull_request", event: { action: "ready_for_review", pull_request: { number: 3 } }, run_id: 20 };
    assert.equal(evaluate(cancellation, ready), "true");
    assert.equal(evaluate(cancellation, { ...ready, event_name: "push" }), "false");
    assert.notEqual(evaluate(group, ready), evaluate(group, { ...ready, event: { ...ready.event, pull_request: { number: 4 } } }));
    for (const action of ["labeled", "unlabeled"]) {
      const administrative = { ...ready, event: { ...ready.event, action, label: { name: "needs-info" } } };
      assert.equal(evaluate(cancellation, administrative), "false");
      for (const gate of ["check", "e2e", "self-hosted"]) {
        const name = workflow.split(`\n  ${gate}:\n`)[1]?.match(/^    name: (.+)$/m)?.[1];
        if (!name) continue;
        assert.equal(evaluate(name, ready), gate);
        assert.notEqual(evaluate(name, administrative), gate, "administrative skips must not replace stable gates");
      }
      assert.notEqual(evaluate(group, administrative), evaluate(group, ready));
      assert.equal(evaluate(cancellation, { ...administrative, event: { ...administrative.event, label: { name: "ci:full" } } }), "true");
    }
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
  assert.match(ci, /name: http-acceptance-logs/);
  assert.doesNotMatch(ci, /playwright|chromium|agent-browser|browser_eval/i);
  assert.match(ci, /if: failure\(\) && steps\.supabase\.outcome == 'failure'/);
  assert.match(ci, /sudo ss -tanp/);
});

// Read the configured execution graph without depending on job identifiers.
// These workflows use one-line needs (a scalar or inline list).
async function ciJobs(filename = "ci.yml") {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL(`../../.github/workflows/${filename}`, import.meta.url), "utf8");
  return [...source.split("\njobs:\n")[1].matchAll(/^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:|$(?![\s\S]))/gm)].map(([, id, body]) => {
    const needs = body.match(/^    needs: (.+)$/m)?.[1] ?? "";
    return { id, body, needs: needs.replace(/[\[\] ]/g, "").split(",").filter(Boolean) };
  });
}

function publishedOutputs(jobs, plan) {
  const classifier = jobs.find(job => job.body.includes("run: node scripts/ci-policy.mjs\n"));
  const publication = { profile: plan.profile, plan: JSON.stringify(plan), ...Object.fromEntries(Object.entries(plan.scopes).map(([scope, required]) => [scope, String(required)])) };
  return Object.fromEntries([...classifier.body.matchAll(/^      ([A-Za-z]+): \$\{\{ steps\.[a-z-]+\.outputs\.([A-Za-z]+) \}\}$/gm)].map(([, name, source]) => [name, publication[source]]));
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
    "scripts/tests/application-shards.test.mjs",
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

test("configured stable gates reject every failed, cancelled, missing or skipped selected job through the CLI", async () => {
  const { spawnSync } = await import("node:child_process");
  const { verificationPlan } = await import("../ci-policy.mjs");
  const cases = [
    { event: "pull_request", files: ["README.md"] },
    { event: "pull_request", draft: true, files: ["src/app/page.tsx"] },
    { event: "pull_request", draft: true, files: ["scripts/agent-tracker.mjs"] },
    { event: "pull_request", draft: true, files: ["deploy/scripts/release-policy.mjs"] },
    { event: "pull_request", files: ["src/app/page.tsx"] },
    { event: "push", files: ["README.md"] },
  ];
  for (const workflow of ["ci.yml", "deployment-check.yml"]) {
    const jobs = await ciJobs(workflow);
    const gates = jobs.filter(job => job.body.includes("run: node scripts/ci-policy.mjs gate"));
    const covered = new Set();
    for (const gate of gates) {
      const environment = Object.fromEntries([...gate.body.matchAll(/^          ([A-Z_]+): (.+)$/gm)].map(([, key, value]) => [key, value.replace(/^'|'$/g, "")]));
      const references = [...new Set(Object.values(environment).flatMap(value => [...value.matchAll(/needs\.([a-z-]+)\.result/g)].map(match => match[1])))];
      for (const reference of references) {
        assert.ok(gate.needs.includes(reference), `${gate.id} awaits its published prerequisite ${reference}`);
        covered.add(reference);
      }
      const run = (input, changes = {}) => {
        const plan = verificationPlan(input);
        const outputs = publishedOutputs(jobs, plan);
        const results = Object.fromEntries(jobs.map(job => {
          const scope = job.body.match(/^    if: needs\.profile\.outputs\.([A-Za-z]+) == 'true'$/m)?.[1];
          return [job.id, scope && outputs[scope] !== "true" ? "skipped" : "success"];
        }));
        Object.assign(results, changes);
        const env = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, value
          .replace(/\$\{\{ needs\.[a-z-]+\.outputs\.([A-Za-z]+) \}\}/g, (_, output) => outputs[output] ?? "")
          .replace(/\$\{\{ needs\.([a-z-]+)\.result \}\}/g, (_, id) => results[id] ?? ""),
        ]));
        return spawnSync(process.execPath, [new URL("../ci-policy.mjs", import.meta.url).pathname, "gate"], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
      };
      for (const input of cases) {
        const result = run(input);
        assert.equal(result.status, 0, `${workflow}/${gate.id}/${JSON.stringify(input)}: ${result.stderr}`);
      }
      for (const reference of references) {
        for (const outcome of ["failure", "cancelled", "skipped", undefined]) {
          const result = run({ event: "push", files: [] }, { [reference]: outcome });
          assert.equal(result.status, 1, `${workflow}/${gate.id} refuses ${reference}=${outcome}`);
        }
      }
    }
    for (const job of jobs.filter(job => !gates.includes(job) && !job.body.includes("run: node scripts/ci-pr-evidence.mjs record"))) {
      assert.ok(covered.has(job.id), `${workflow}/${job.id} contributes actual result evidence to a stable gate`);
    }
  }
});

test("configured jobs consume actual published scopes for documentation, drafts and complete ready application verification", async () => {
  const { verificationPlan } = await import("../ci-policy.mjs");
  const cases = [
    [{ event: "pull_request", draft: true, files: ["README.md"] }, [], [], "docs draft"],
    [{ event: "pull_request", files: ["README.md"] }, [], [], "docs ready"],
    [{ event: "pull_request", draft: true, files: ["src/app/page.tsx"] }, ["common"], [], "app draft"],
    [{ event: "pull_request", draft: true, files: ["scripts/agent-tracker.mjs"] }, ["common", "tracker"], [], "tracker draft"],
    [{ event: "pull_request", draft: true, files: ["deploy/scripts/release-policy.mjs"] }, ["common", "release"], [], "release draft"],
    [{ event: "pull_request", draft: true, files: [".github/workflows/ci.yml"] }, ["common", "tracker", "release"], [], "CI draft"],
    [{ event: "pull_request", files: ["src/app/page.tsx"] }, ["common", "full", "acceptance"], ["runtime"], "app ready"],
    [{ event: "pull_request", draft: true, fullVerification: true, files: ["README.md"] }, ["tracker", "common", "release", "full", "acceptance"], ["runtime"], "override"],
    [{ event: "push", files: ["README.md"] }, ["tracker", "common", "release", "full", "acceptance"], ["runtime"], "main docs stays full"],
  ];
  for (const [workflow, expectedIndex] of [["ci.yml", 1], ["deployment-check.yml", 2]]) {
    const jobs = await ciJobs(workflow);
    for (const entry of cases) {
      const [input, , , description] = entry;
      const outputs = publishedOutputs(jobs, verificationPlan(input));
      const selected = jobs.filter(job => !job.body.includes("run: node scripts/ci-policy.mjs gate") && !job.body.includes("run: node scripts/ci-policy.mjs\n") && !job.body.includes("run: node scripts/ci-pr-evidence.mjs record")).filter(job => {
        const condition = job.body.match(/^    if: (.+)$/m)?.[1];
        if (!condition) return true;
        const scope = condition.match(/^needs\.profile\.outputs\.([A-Za-z]+) == 'true'$/)?.[1];
        assert.ok(scope, `workflow condition must consume a published scope: ${condition}`);
        return outputs[scope] === "true";
      }).map(job => job.id);
      assert.deepEqual(selected.sort(), [...entry[expectedIndex]].sort(), `${workflow}/${description}`);
    }
  }
});
