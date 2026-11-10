import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

const provider = JSON.parse(readFileSync(new URL("./fixtures/ci-timings-provider.json", import.meta.url)));
const root = "repos/Thomisso/iVAT";
function fixture(t, { attempts = provider.attempts, jobs = provider.jobs, responses = {} } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ivat-ci-timings-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = attempts.at(-1);
  const routes = { [`${root}/actions/runs/${run.id}`]: run, ...responses };
  attempts.forEach((attempt, index) => {
    routes[`${root}/actions/runs/${run.id}/attempts/${attempt.run_attempt}`] = attempt;
    routes[`${root}/actions/runs/${run.id}/attempts/${attempt.run_attempt}/jobs?per_page=100&page=1`] ??= { total_count: jobs[index].length, jobs: jobs[index] };
  });
  writeFileSync(path.join(directory, "routes.json"), JSON.stringify(routes));
  writeFileSync(path.join(directory, "gh"), `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='repo') { console.log(JSON.stringify({nameWithOwner:'Thomisso/iVAT'})); }
else {
 const routes=JSON.parse(fs.readFileSync(process.env.TIMING_FIXTURE));
 let value=routes[args[1]];
 if(value?.sequence) {
   const file=process.env.TIMING_FIXTURE+'.counts';
   const counts=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};
   const index=counts[args[1]]??0; counts[args[1]]=index+1; fs.writeFileSync(file,JSON.stringify(counts));
   value=value.sequence[index];
 }
 if(value===undefined) { console.error('Unavailable fixture route '+args[1]); process.exit(1); }
 if(value.binary) process.stdout.write(Buffer.from(value.binary,'base64')); else if(typeof value==='string') process.stdout.write(value); else console.log(JSON.stringify(value));
}\n`);
  chmodSync(path.join(directory, "gh"), 0o755);
  return (ids = [String(run.id)]) => spawnSync(process.execPath, [new URL("../ci-timings.mjs", import.meta.url).pathname, ...ids], {
    encoding: "utf8", env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, TIMING_FIXTURE: path.join(directory, "routes.json") },
  });
}

test("timing CLI retains a failed earlier attempt and excludes skipped jobs from all-attempt usage", t => {
  const result = fixture(t)();
  assert.equal(result.status, 0, result.stderr);
  const [report] = JSON.parse(result.stdout);
  assert.deepEqual(report.attempts.map(attempt => [attempt.attempt, attempt.conclusion, attempt.queueSeconds, attempt.wallSeconds]), [[1, "failure", 2, 852], [2, "success", 3, 1436]]);
  assert.equal(report.totals.runnerSeconds, 3593);
  assert.equal(report.totals.roundedJobMinutes, 66);
  assert.equal(report.attempts[0].jobs.filter(job => job.execution === "not-started").length, 2);
  assert.equal(report.actualBilling, "unavailable");
  assert.equal(report.attempts[1].observedWork.typechecks, 3);
  assert.equal(report.attempts[1].observedWork.plainBuilds, 3);
});

test("billing refusal timestamps are not runner execution or product-test evidence", t => {
  const job = provider.billingJob;
  const run = { ...provider.attempts[0], id: job.run_id, run_attempt: 1, created_at: job.created_at };
  const result = fixture(t, { attempts: [run], jobs: [[job]], responses: {
    [`${root}/check-runs/${job.id}/annotations?per_page=100&page=1`]: provider.billingAnnotations,
  } })();
  assert.equal(result.status, 0, result.stderr);
  const [report] = JSON.parse(result.stdout);
  const attempt = report.attempts[0];
  assert.equal(attempt.runnerSeconds, 0);
  assert.equal(attempt.roundedJobMinutes, 0);
  assert.equal(attempt.wallSeconds, null);
  assert.equal(attempt.jobs[0].rawIntervalSeconds, 2);
  assert.equal(attempt.jobs[0].failure.type, "billing-refusal");
  assert.equal(attempt.jobs[0].failure.cause, "payments-failed-or-spending-limit");
});

test("timing CLI collects every page beyond 100 jobs and refuses missing or wrong-attempt evidence", t => {
  // Shape-expanded provider jobs, not an invented timing benchmark.
  const attempt = provider.attempts[0];
  const jobs = Array.from({ length: 101 }, (_, index) => ({ ...provider.jobs[0][0], id: 900000 + index }));
  const route = `${root}/actions/runs/${attempt.id}/attempts/1/jobs?per_page=100&page=`;
  const responses = { [`${route}1`]: { total_count: 101, jobs: jobs.slice(0, 100) }, [`${route}2`]: { total_count: 101, jobs: jobs.slice(100) } };
  const result = fixture(t, { attempts: [attempt], jobs: [jobs], responses })();
  assert.equal(result.status, 0, result.stderr);
  const [report] = JSON.parse(result.stdout);
  assert.equal(report.attempts[0].jobs.length, 101);
  assert.equal(report.totals.runnerSeconds, 84840);
  assert.equal(report.totals.roundedJobMinutes, 1414);
  for (const second of [{ total_count: 101, jobs: [] }, { total_count: 102, jobs: jobs.slice(100) }, { total_count: 101, jobs: [jobs[0]] }, { total_count: 101, jobs: [{ ...jobs[100], run_attempt: 2 }] }]) {
    const invalid = fixture(t, { attempts: [attempt], jobs: [jobs], responses: { ...responses, [`${route}2`]: second } })();
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, "");
  }
});

test("actual failed logs distinguish startup, application and tracker test failures without assigning product blame", t => {
  for (const sample of provider.failureCases) {
    const run = { ...provider.attempts[0], id: sample.job.run_id, head_sha: sample.job.head_sha };
    const result = fixture(t, { attempts: [run], jobs: [[sample.job]], responses: {
      [`${root}/actions/jobs/${sample.job.id}/logs`]: sample.log,
    } })();
    assert.equal(result.status, 0, result.stderr);
    const job = JSON.parse(result.stdout)[0].attempts[0].jobs[0];
    assert.equal(job.failure.type, sample.name === "startup" ? "startup-infrastructure" : "test-failure");
    if (sample.name !== "startup") assert.equal(job.failure.scope, sample.name === "test" ? "application" : "tracker");
  }
});

test("explicit human cancellation is not mislabeled superseded and missing evidence stays unknown", t => {
  const job = provider.cancelledJob;
  const run = { ...provider.attempts[0], id: job.run_id, head_sha: job.head_sha, conclusion: "cancelled" };
  const responses = { [`${root}/check-runs/${job.id}/annotations?per_page=100&page=1`]: provider.cancelledAnnotations };
  const known = fixture(t, { attempts: [run], jobs: [[job]], responses })();
  assert.equal(known.status, 0, known.stderr);
  assert.equal(JSON.parse(known.stdout)[0].attempts[0].jobs[0].failure.cause, "human");
  const superseded = fixture(t, { attempts: [run], jobs: [[job]], responses: { [`${root}/check-runs/${job.id}/annotations?per_page=100&page=1`]: [{ annotation_level: "failure", message: "Canceling since a higher priority waiting request for ci-262 exists" }] } })();
  assert.equal(JSON.parse(superseded.stdout)[0].attempts[0].jobs[0].failure.cause, "superseded");
  const unknown = fixture(t, { attempts: [run], jobs: [[job]] })();
  assert.equal(JSON.parse(unknown.stdout)[0].attempts[0].jobs[0].failure.cause, "unknown");
});

test("checkout evidence preserves the tested merge separately from API head and unavailable scope/target", t => {
  const sample = provider.failureCases.find(sample => sample.name === "tracker");
  const run = { ...provider.attempts[0], id: sample.job.run_id, head_sha: sample.job.head_sha, pull_requests: [] };
  const result = fixture(t, { attempts: [run], jobs: [[sample.job]], responses: { [`${root}/actions/jobs/${sample.job.id}/logs`]: sample.log } })();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout)[0];
  assert.equal(report.revision, "7f0e3dd29948ccd2cafaf4596090bcf584211503");
  assert.equal(report.attempts[0].provenance.checkedRevision, "aa7aa135a561e2141ec31357221b7434ec3a3023");
  assert.equal(report.attempts[0].provenance.scope.status, "unverified");
  assert.equal(report.attempts[0].provenance.recordedTarget, null);
});

test("docs and draft report observed scope reasons without inventing a tested target or full proof", t => {
  for (const profile of ["docs", "draft"]) {
    const run = { ...provider.attempts[0], conclusion: "success" };
    const job = { ...provider.jobs[0][0], conclusion: "success", name: "CI profile", steps: [{ name: "Select verification plan", status: "completed", conclusion: "success", started_at: "2026-11-08T11:35:14Z", completed_at: "2026-11-08T11:35:14Z" }] };
    const log = `2026-11-08T11:35:14Z Verification profile: ${profile} (${profile === "docs" ? "documentation-only" : "draft-change"})\n2026-11-08T11:35:14Z common: ${profile === "docs" ? "not applicable (documentation-only)" : "required (code-checks)"}\n2026-11-08T11:35:14Z application: not applicable (${profile === "docs" ? "application-inputs-unchanged" : "draft-awaiting-readiness"})\n`;
    const result = fixture(t, { attempts: [run], jobs: [[job]], responses: { [`${root}/actions/jobs/${job.id}/logs`]: log } })();
    assert.equal(result.status, 0, result.stderr);
    const provenance = JSON.parse(result.stdout)[0].attempts[0].provenance;
    assert.equal(provenance.scope.status, "log-observed");
    assert.equal(provenance.scope.plan.profile, profile);
    assert.equal(provenance.scope.plan.scopes.common, profile === "draft");
    assert.equal(provenance.scope.plan.scopes.application, false);
    assert.equal(provenance.recordedTarget, null);
  }
});

function archive(t, file, proof) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ivat-timing-archive-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, file), JSON.stringify(proof));
  const output = path.join(directory, "proof.zip");
  execFileSync("zip", ["-q", "-0", output, file], { cwd: directory, timeout: 5000, stdio: "pipe" });
  return readFileSync(output);
}

function artifactFixture(t, change = () => {}) {
  // Synthetic identities in real PR-proof/provider shapes, not historical facts.
  const context = { repository: "thomisso/ivat", headRepository: "thomisso/ivat", workflow: "ci.yml", workflowId: 7, runId: 20, runAttempt: 1, pr: 3, head: "a".repeat(40), checked: "b".repeat(40), target: "main", targetSha: "c".repeat(40), policy: "d".repeat(64) };
  const scopes = { common: true, tracker: true, trackerTransport: true, release: true, application: true, http: true, deployment: true };
  const proof = { kind: "ivat-pr-verification-v1", fresh: true, context, plan: { version: 1, profile: "full", reason: "full-override", scopes, reasons: Object.fromEntries(Object.keys(scopes).map(scope => [scope, "full-override"])) }, results: { policy: "success", common: "success", tracker: "success", trackerTransport: "success", release: "success", application: "success", http: "success", deployment: "success" } };
  const run = { ...provider.attempts[1], id: 20, run_attempt: 1, workflow_id: 7, event: "pull_request", path: ".github/workflows/ci.yml", head_sha: context.head, repository: { full_name: "Thomisso/iVAT" }, head_repository: { full_name: "Thomisso/iVAT" }, pull_requests: [{ number: 3 }] };
  const jobs = ["CI profile", "common", "tracker", "release", "full (1)", "full (2)", "full (3)", "acceptance", "check", "e2e", "PR verification evidence"].map((name, index) => ({ ...provider.jobs[1][0], id: 800000 + index, run_id: 20, run_attempt: 1, head_sha: context.head, name }));
  const artifact = { id: 42, name: "pr-verification-1", expired: false, expires_at: "2099-01-01T00:00:00Z", workflow_run: { id: 20, head_sha: context.head } };
  change({ run, proof, jobs, artifact });
  const bytes = archive(t, "pr-verification.json", proof);
  artifact.digest ??= `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return fixture(t, { attempts: [run], jobs: [jobs], responses: {
    [`${root}/actions/runs/20/artifacts?per_page=100&page=1`]: { total_count: 1, artifacts: [artifact] },
    [`${root}/actions/artifacts/42/zip`]: { binary: bytes.toString("base64") },
    [`${root}/pulls/3`]: { number: 3, head: { sha: context.head }, base: { ref: "main", sha: "f".repeat(40) } },
    [`${root}/branches/main`]: { name: "main", commit: { sha: "f".repeat(40) } },
  } });
}

test("artifact scope is bound to its original attempt and target while current target drift stays separate", t => {
  const result = artifactFixture(t)();
  assert.equal(result.status, 0, result.stderr);
  const provenance = JSON.parse(result.stdout)[0].attempts[0].provenance;
  assert.equal(provenance.scope.status, "corroborated-record");
  assert.equal(provenance.scope.plan.scopes.tracker, true);
  assert.equal(provenance.checkedRevision, "b".repeat(40));
  assert.equal(provenance.recordedTarget.sha, "c".repeat(40));
  assert.equal(provenance.currentTarget.sha, "f".repeat(40));
  assert.equal(provenance.currentTarget.matchesRecorded, false);
  assert.equal(provenance.approvesCurrentTarget, false);
  for (const change of [value => { value.proof.context.runAttempt = 2; }, value => { value.artifact.expired = true; }, value => { value.artifact.digest = `sha256:${"0".repeat(64)}`; }, value => { value.jobs.find(job => job.name === "full (2)").conclusion = "skipped"; }]) {
    const invalid = artifactFixture(t, change)();
    assert.equal(invalid.status, 0, invalid.stderr);
    assert.equal(JSON.parse(invalid.stdout)[0].attempts[0].provenance.scope.status, "unverified");
  }
});

test("missing/reversed intervals and unfinished runs retain partial observations instead of complete zero totals", t => {
  const run = provider.attempts[0];
  const base = provider.jobs[0][0];
  for (const job of [{ ...base, completed_at: null }, { ...base, completed_at: "2026-11-08T11:00:00Z" }, { ...base, steps: undefined, runner_id: null, runner_name: "" }]) {
    const result = fixture(t, { attempts: [run], jobs: [[job]] })();
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout)[0];
    assert.equal(report.totals.complete, false);
    assert.equal(report.totals.runnerSeconds, null);
    assert.equal(report.totals.roundedJobMinutes, null);
    assert.equal(report.attempts[0].wallSeconds, null);
  }
  const waiting = fixture(t, { attempts: [{ ...run, status: "queued", conclusion: null }], jobs: [[]] })();
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.equal(JSON.parse(waiting.stdout)[0].totals.complete, false);
});

test("a current PR target can be observed without fabricating the target tested by a proofless run", t => {
  const run = { ...provider.attempts[0], event: "pull_request", pull_requests: [{ number: 3 }] };
  const result = fixture(t, { attempts: [run], jobs: [provider.jobs[0]], responses: {
    [`${root}/pulls/3`]: { number: 3, head: { sha: run.head_sha }, base: { ref: "main", sha: "f".repeat(40) } },
    [`${root}/branches/main`]: { name: "main", commit: { sha: "f".repeat(40) } },
  } })();
  assert.equal(result.status, 0, result.stderr);
  const provenance = JSON.parse(result.stdout)[0].attempts[0].provenance;
  assert.equal(provenance.recordedTarget, null);
  assert.equal(provenance.currentTarget.sha, "f".repeat(40));
  assert.equal(provenance.currentTarget.matchesRecorded, null);
});

test("candidate timing scope requires the existing full job-and-step validator", t => {
  // Synthetic candidate from the release-evidence contract's worked example.
  const revision = "a".repeat(40);
  const expected = { schemaVersion: 1, purpose: "release", runHead: revision, sourceRef: "refs/tags/v0.2.0", repository: "thomisso/ivat", revision, tag: "v0.2.0", targetRevision: revision,
    sourceTree: "b".repeat(40), policyDigest: "c".repeat(64), inputsDigest: "f6268a70ea46075f09108dcd549c717b4934517cd46308d6648e8496a325af44", requestId: "12345678-1234-4123-8123-123456789abc", requestedAt: "2026-11-09T12:00:00Z",
    publicBuild: { supabaseUrl: "https://api.ivat.cz", publishableKey: "sb_publishable_test" }, platform: "linux/amd64" };
  const steps = {
    "CI profile": ["Select verification plan"], tracker: ["Agent tracker command behavior", "Agent tracker through real gh and controlled GitHub HTTP"],
    common: ["Application shard coverage and measured allocation", "package-lock.json matches package.json", "Typecheck", "Lint"], release: ["Release policy, bundle integrity, transport and host preflight"],
    "full (1)": ["Complete application shard", "Generated database types match the migrations"], "full (2)": ["Complete application shard"], "full (3)": ["Complete application shard"],
    acceptance: ["Production HTTP acceptance"], check: ["Enforce verification gate"], e2e: ["Enforce verification gate"], "Deployment profile": ["Select verification plan"],
    runtime: ["Build the production images", "Boot the production runtime with local-only test access", "Re-running migrations preserves the deployment", "Application behavior against self-hosted Supabase", "Production web through the reverse proxy", "Runtime source retains the same immutable generator identity", "EPO schema and XML runtime assets in the production image"], "self-hosted": ["Enforce verification gate"],
  };
  const run = { ...provider.attempts[1], id: 20, run_attempt: 1, repository: { id: 99, full_name: "Thomisso/iVAT" }, head_repository: { id: 99, full_name: "Thomisso/iVAT" }, head_sha: revision,
    path: ".github/workflows/release-verification.yml", event: "workflow_dispatch", display_title: `Release verification ${expected.requestId}`, run_started_at: "2026-11-09T12:01:00Z", created_at: "2026-11-09T12:01:00Z",
    referenced_workflows: ["ci.yml", "deployment-check.yml"].map(file => ({ path: `thomisso/ivat/.github/workflows/${file}@refs/tags/v0.2.0`, sha: revision })) };
  const scopes = { common: true, tracker: true, trackerTransport: true, release: true, application: true, http: true, deployment: true };
  const proof = { ...expected, runId: 20, runAttempt: 1, plan: { version: 1, profile: "full", reason: "full-override", scopes, reasons: Object.fromEntries(Object.keys(scopes).map(scope => [scope, "full-override"])) }, results: { application: "success", deployment: "success" } };
  const jobs = Object.entries(steps).map(([name, names], index) => ({ ...provider.jobs[1][0], id: 900000 + index, run_id: 20, run_attempt: 1, head_sha: revision, name: `Verification / ${name}`, started_at: "2026-11-09T12:02:00Z", completed_at: "2026-11-09T12:10:00Z", steps: names.map(name => ({ name, status: "completed", conclusion: "success", started_at: "2026-11-09T12:02:00Z", completed_at: "2026-11-09T12:10:00Z" })) }));
  const collect = () => {
    const bytes = archive(t, "release-evidence.json", proof);
    const artifact = { id: 42, name: "release-verification-20-1", expired: false, expires_at: "2099-01-01T00:00:00Z", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, workflow_run: { id: 20, repository_id: 99, head_repository_id: 99, head_sha: revision } };
    const result = fixture(t, { attempts: [run], jobs: [jobs], responses: {
      [`${root}/actions/runs/20/artifacts?per_page=100&page=1`]: { total_count: 1, artifacts: [artifact] }, [`${root}/actions/artifacts/42/zip`]: { binary: bytes.toString("base64") },
      [`${root}/branches/main`]: { name: "main", commit: { sha: revision } },
    } })();
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout)[0].attempts[0].provenance;
  };
  const complete = collect();
  assert.equal(complete.scope.status, "corroborated-record");
  assert.equal(complete.candidate.inputsDigest, "f6268a70ea46075f09108dcd549c717b4934517cd46308d6648e8496a325af44");
  assert.equal(complete.approvesCurrentTarget, false);
  jobs.find(job => job.name.endsWith(" / runtime")).steps[0].conclusion = "skipped";
  assert.equal(collect().scope.status, "unverified");
});

test("a run changing during collection and invalid IDs cannot publish a complete report", t => {
  const run = provider.attempts[0];
  const collect = fixture(t, { attempts: [run], jobs: [provider.jobs[0]], responses: { [`${root}/actions/runs/${run.id}`]: { sequence: [run, { ...run, run_attempt: 2 }] } } });
  const changed = collect();
  assert.notEqual(changed.status, 0);
  assert.equal(changed.stdout, "");
  assert.match(changed.stderr, /changed during collection/);
  for (const ids of [[], ["0"], ["-1"], ["12oops"], ["9007199254740992"]]) {
    const invalid = collect(ids);
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /Usage:/);
  }
});
