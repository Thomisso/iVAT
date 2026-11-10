// Read-only GitHub evidence: node scripts/ci-timings.mjs RUN_ID...
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordedPrEvidence } from "./ci-pr-evidence.mjs";
import { validateCandidateEvidence } from "../deploy/scripts/release-evidence.mjs";

const positive = value => Number.isSafeInteger(value) && value > 0;
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const seconds = (start, end) => timestamp(start) && timestamp(end) && Date.parse(end) >= Date.parse(start) ? (Date.parse(end) - Date.parse(start)) / 1000 : null;
const command = (args, binary = false) => execFileSync("gh", args, { encoding: binary ? undefined : "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
const api = route => JSON.parse(command(["api", route]));

function list(route, key) {
  const values = [];
  let total;
  for (let page = 1; page <= 100; page++) {
    const body = api(`${route}?per_page=100&page=${page}`);
    if (!Array.isArray(body?.[key]) || !Number.isSafeInteger(body.total_count) || body.total_count < 0 || (total !== undefined && total !== body.total_count)) throw new Error(`Incomplete pagination: ${route}`);
    total = body.total_count;
    values.push(...body[key]);
    if (values.length === total) return values;
    if (!body[key].length || values.length > total) break;
  }
  throw new Error(`Incomplete pagination: ${route}`);
}

function annotations(root, id) {
  const values = [];
  for (let page = 1; page <= 100; page++) {
    const body = api(`${root}/check-runs/${id}/annotations?per_page=100&page=${page}`);
    if (!Array.isArray(body)) throw new Error("Invalid annotation page");
    values.push(...body);
    if (body.length < 100) return values;
  }
  throw new Error("Incomplete annotations");
}
function failureEvidence(job, values, log) {
  const billing = values.find(item => /job was not started because recent account payments have failed or your spending limit/i.test(item.message));
  if (billing) return { type: "billing-refusal", cause: "payments-failed-or-spending-limit", evidence: billing.message };
  if (job.conclusion === "cancelled") {
    const human = values.find(item => /run was cancel[el]+d by @/i.test(item.message));
    const superseded = values.find(item => /canceling since a higher priority waiting request|cancel[el]+d.*superseded by/i.test(item.message));
    return { type: "cancellation", cause: human ? "human" : superseded ? "superseded" : "unknown", evidence: human?.message ?? superseded?.message ?? null };
  }
  if (!["failure", "timed_out", "startup_failure"].includes(job.conclusion)) return null;
  const lines = log.split("\n");
  const startup = lines.find(line => /failed to start docker container|failed to bind host port|Error: listen EADDRINUSE/.test(line));
  if (startup) return { type: "startup-infrastructure", cause: "startup-error-observed", evidence: startup.slice(0, 2000) };
  const failedTest = lines.find(line => /\bFAIL\s+(?:tests|deploy\/tests|scripts\/tests)\/|not ok \d+ - /.test(line));
  if (failedTest) return { type: "test-failure", cause: "test-output-observed", scope: /\bFAIL\s+tests\//.test(failedTest) ? "application" : /tracker/i.test(job.name + job.steps?.filter(step => step.conclusion === "failure").map(step => step.name).join(" ")) ? "tracker" : "tooling", evidence: failedTest.slice(0, 2000) };
  if (job.steps?.some(step => step.conclusion === "failure" && /(?:Enforce verification gate|ci-policy\.mjs gate)/.test(step.name))) return { type: "gate-failure", cause: "required-verification-did-not-succeed" };
  return { type: "unknown-failure", cause: "unknown" };
}

function observedSelection(job, log) {
  if (!/(?:^| \/ )(?:CI profile|Deployment profile)$/.test(job.name) || !job.steps?.some(step => step.conclusion === "success" && /Select verification plan|Run node scripts\/ci-policy\.mjs$/.test(step.name))) return null;
  const lines = log.split("\n").map(line => line.replace(/^\d{4}-[^ ]+Z /, ""));
  const profile = lines.map(line => line.match(/^Verification profile: (docs|draft|full) \((.*)\)$/)).find(Boolean);
  if (!profile) return null;
  const scopes = {}, reasons = {};
  for (const line of lines) {
    const match = line.match(/^([a-zA-Z]+): (required|not applicable) \((.*)\)$/);
    if (match) { scopes[match[1]] = match[2] === "required"; reasons[match[1]] = match[3]; }
  }
  return { profile: profile[1], reason: profile[2], scopes, reasons };
}

function observedWork(jobs) {
  const steps = jobs.flatMap(job => job.execution === "started" ? job.steps.filter(step => step.conclusion !== "skipped" && timestamp(step.startedAt)) : []);
  const byName = new Map();
  for (const step of steps) byName.set(step.name, (byName.get(step.name) ?? 0) + 1);
  const count = expression => steps.filter(step => expression.test(step.name)).length;
  return {
    plainBuilds: jobs.reduce((sum, job) => sum + Math.max(job.logs.plainBuilds ?? 0, job.steps.filter(step => step.conclusion !== "skipped" && timestamp(step.startedAt) && /(?:Run npm run build|^Build application$)/.test(step.name)).length), 0),
    imageBuilds: count(/^Build the production images$/), typechecks: count(/^(?:Typecheck|Run npm run typecheck)$/),
    lint: count(/^(?:Lint|Run npm run lint)$/), dependencyInstalls: count(/^Run npm ci$/),
    repeatedSteps: [...byName].filter(([, count]) => count > 1).map(([name, count]) => ({ name, count })),
    unavailableLogs: jobs.filter(job => job.execution === "started" && !job.logs.available).map(job => job.id),
  };
}

function describeJob(job, root) {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const assigned = positive(job.runner_id) || Boolean(job.runner_name);
  const executed = steps.some(step => step.conclusion !== "skipped" && timestamp(step.started_at));
  const execution = job.conclusion === "skipped" || (!assigned && Array.isArray(job.steps) && !steps.length) ? "not-started" : assigned || executed ? "started" : "unknown";
  const duration = execution === "started" && job.status === "completed" ? seconds(job.started_at, job.completed_at) : null;
  let annotationEvidence = { available: false, values: [], reason: "not-required" };
  if (job.conclusion !== "success" && job.conclusion !== "skipped") {
    try { annotationEvidence = { available: true, values: annotations(root, job.id) }; }
    catch { annotationEvidence = { available: false, values: [], reason: "annotations-unavailable" }; }
  }
  let log = "";
  let logAvailable = false;
  if (execution === "started") {
    try { log = command(["api", `${root}/actions/jobs/${job.id}/logs`]); logAvailable = true; }
    catch { /* Logs can expire or require additional access. Keep facts unknown. */ }
  }
  const checkoutRevisions = [...new Set([...log.matchAll(/\[command\][^\n]*git log -1 --format=%H\r?\n(?:[^\n]*?Z )?([a-f0-9]{40})(?:\r?\n|$)/g)].map(match => match[1]))];
  const failure = failureEvidence(job, annotationEvidence.values, log);
  return {
    id: job.id, source: `${root}/actions/jobs/${job.id}`, revision: job.head_sha, attempt: job.run_attempt, name: job.name, status: job.status, conclusion: job.conclusion,
    labels: job.labels, runnerId: job.runner_id, runnerName: job.runner_name, runnerGroupId: job.runner_group_id, runnerGroupName: job.runner_group_name,
    createdAt: job.created_at, startedAt: job.started_at, completedAt: job.completed_at,
    failure, annotations: annotationEvidence,
    logs: { available: logAvailable, reason: logAvailable ? null : "logs-unavailable-or-job-not-started", source: `${root}/actions/jobs/${job.id}/logs`, checkoutRevisions,
      environment: log.split("\n").filter(line => /Current runner version:|Image:|Image Version:|Version: \d{8}|Image Release:|Cache restored from key:|Cache not found|Cache hit/.test(line)).slice(0, 30).map(line => line.slice(0, 500)),
      selection: observedSelection(job, log),
      plainBuilds: logAvailable ? [...log.matchAll(/^.*> next build\s*$/gm)].length : null },
    execution, exclusionReason: execution === "not-started" ? job.conclusion === "skipped" ? "skipped" : "no-runner-or-steps" : null,
    queueSeconds: execution === "started" ? seconds(job.created_at, job.started_at) : null,
    rawIntervalSeconds: seconds(job.started_at, job.completed_at), seconds: duration,
    roundedJobMinutes: duration === null ? null : Math.max(1, Math.ceil(duration / 60)),
    steps: steps.map(step => ({ name: step.name, number: step.number, status: step.status, conclusion: step.conclusion,
      startedAt: step.started_at, completedAt: step.completed_at,
      seconds: step.conclusion === "skipped" ? null : seconds(step.started_at, step.completed_at) })),
  };
}

function timing(jobs, createdAt, status) {
  const started = jobs.filter(job => job.execution === "started");
  const first = started.map(job => job.startedAt).filter(timestamp).sort()[0] ?? null;
  const last = started.map(job => job.completedAt).filter(timestamp).sort().at(-1) ?? null;
  const unknownJobs = jobs.filter(job => job.execution === "unknown" || (job.execution === "started" && job.seconds === null)).length;
  const observedRunnerSeconds = started.reduce((sum, job) => sum + (job.seconds ?? 0), 0);
  const observedRoundedJobMinutes = started.reduce((sum, job) => sum + (job.roundedJobMinutes ?? 0), 0);
  const complete = unknownJobs === 0 && status === "completed";
  return {
    startedAt: first, completedAt: complete ? last : null,
    queueSeconds: seconds(createdAt, first), wallSeconds: complete ? seconds(first, last) : null,
    runnerSeconds: complete ? observedRunnerSeconds : null,
    roundedJobMinutes: complete ? observedRoundedJobMinutes : null,
    observedRunnerSeconds, observedRoundedJobMinutes, unknownJobs, complete,
  };
}

function artifactProof(root, artifact, file) {
  if (!positive(artifact.id) || artifact.expired !== false || !timestamp(artifact.expires_at) || Date.parse(artifact.expires_at) <= Date.now()) throw new Error("artifact-expired-or-invalid");
  const archive = command(["api", `${root}/actions/artifacts/${artifact.id}/zip`], true);
  if (`sha256:${createHash("sha256").update(archive).digest("hex")}` !== artifact.digest) throw new Error("artifact-digest-mismatch");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-timing-proof-"));
  try {
    const archivePath = path.join(directory, "proof.zip"); fs.writeFileSync(archivePath, archive);
    const options = { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
    if (execFileSync("unzip", ["-Z1", archivePath], options).trim() !== file) throw new Error("artifact-inventory-mismatch");
    return JSON.parse(execFileSync("unzip", ["-p", archivePath, file], options));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function corroborate(root, run, rawJobs, jobs, provenance, artifacts) {
  const matches = artifacts.filter(artifact => [`pr-verification-${run.run_attempt}`, `release-verification-${run.id}-${run.run_attempt}`].includes(artifact.name));
  if (!matches.length) { provenance.artifact = { status: "unavailable", reason: "no-supported-artifact" }; return; }
  try {
    if (matches.length !== 1) throw new Error("ambiguous-artifacts");
    const artifact = matches[0];
    const candidate = artifact.name.startsWith("release-verification-");
    const proof = artifactProof(root, artifact, candidate ? "release-evidence.json" : "pr-verification.json");
    let checked, target, policy;
    if (candidate) {
      const expected = Object.fromEntries(Object.entries(proof).filter(([key]) => !["runId", "runAttempt", "plan", "results"].includes(key)));
      validateCandidateEvidence({ run, proof, jobs: rawJobs, artifact }, expected);
      checked = proof.revision; target = { ref: "main", sha: proof.targetRevision }; policy = proof.policyDigest;
    } else {
      if (!recordedPrEvidence({ proof, run, jobs: rawJobs, jobAttempt: run.run_attempt, artifact })) throw new Error("recorded-pr-proof-invalid");
      checked = proof.context.checked; target = { ref: proof.context.target, sha: proof.context.targetSha }; policy = proof.context.policy;
    }
    if (jobs.some(job => job.logs.checkoutRevisions.some(revision => revision !== checked))) throw new Error("checkout-log-disagrees-with-artifact");
    provenance.checkedRevision = checked;
    provenance.recordedTarget = target;
    provenance.policy = policy;
    provenance.scope = { status: "corroborated-record", plan: proof.plan, results: proof.results, source: `${root}/actions/artifacts/${artifact.id}/zip` };
    provenance.artifact = { status: "corroborated-record", id: artifact.id, name: artifact.name, digest: artifact.digest };
    if (candidate) provenance.candidate = { purpose: proof.purpose, revision: proof.revision, tag: proof.tag, sourceTree: proof.sourceTree, inputsDigest: proof.inputsDigest, sourceRef: proof.sourceRef };
    try {
      const branch = api(`${root}/branches/${encodeURIComponent(target.ref)}`);
      if (!/^[a-f0-9]{40}$/.test(branch.commit?.sha)) throw new Error("invalid-current-target");
      const current = candidate ? null : api(`${root}/pulls/${proof.context.pr}`);
      provenance.currentTarget = { available: true, ref: target.ref, sha: branch.commit.sha, observedAt: new Date().toISOString(),
        matchesRecorded: branch.commit.sha === target.sha && (candidate || (current.number === proof.context.pr && current.base?.ref === target.ref && current.base?.sha === target.sha && current.head?.sha === proof.context.head)) };
    } catch { provenance.currentTarget = { available: false, reason: "current-target-unavailable" }; }
  } catch (error) {
    provenance.artifact = { status: "unverified", reason: error.status ? "artifact-unavailable" : error.message };
  }
}

function currentTarget(root, run, provenance) {
  if (provenance.currentTarget.available) return;
  try {
    let ref;
    let current;
    const prs = run.pull_requests?.filter(pr => positive(pr.number));
    if (run.event === "pull_request" && prs?.length === 1) {
      current = api(`${root}/pulls/${prs[0].number}`);
      if (current.number !== prs[0].number) throw new Error("Wrong current PR");
      ref = current.base?.ref;
    } else if (run.event === "push") ref = run.head_branch;
    if (typeof ref !== "string" || !ref.length) return;
    const branch = api(`${root}/branches/${encodeURIComponent(ref)}`);
    if (!/^[a-f0-9]{40}$/.test(branch.commit?.sha)) throw new Error("Invalid current target");
    provenance.currentTarget = { available: true, ref, sha: branch.commit.sha, observedAt: new Date().toISOString(),
      matchesRecorded: provenance.recordedTarget ? ref === provenance.recordedTarget.ref && branch.commit.sha === provenance.recordedTarget.sha && (!current || current.base?.sha === branch.commit.sha) : null };
  } catch { provenance.currentTarget = { available: false, reason: "current-target-unavailable" }; }
}

function reportRun(repository, id) {
  const root = `repos/${repository}`;
  const run = api(`${root}/actions/runs/${id}`);
  if (run.id !== Number(id) || !positive(run.run_attempt) || !/^[a-f0-9]{40}$/.test(run.head_sha) || run.repository?.full_name?.toLowerCase() !== repository.toLowerCase()) throw new Error(`Invalid run identity: ${id}`);
  let artifacts = [];
  let artifactsAvailable = true;
  try { artifacts = list(`${root}/actions/runs/${id}/artifacts`, "artifacts"); }
  catch { artifactsAvailable = false; }
  const attempts = [];
  const seen = new Set();
  for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
    const route = `${root}/actions/runs/${id}/attempts/${attempt}`;
    const source = api(route);
    if (source.id !== run.id || source.run_attempt !== attempt || source.head_sha !== run.head_sha) throw new Error(`Wrong attempt identity: ${route}`);
    const rawJobs = list(`${route}/jobs`, "jobs");
    for (const job of rawJobs) {
      if (!positive(job.id) || seen.has(job.id) || job.run_id !== run.id || job.run_attempt !== attempt || job.head_sha !== source.head_sha) throw new Error(`Wrong or duplicate job identity: ${route}`);
      seen.add(job.id);
    }
    const jobs = rawJobs.map(job => describeJob(job, root));
    const checked = [...new Set(jobs.flatMap(job => job.logs.checkoutRevisions))];
    const selected = jobs.filter(job => job.logs.selection);
    const provenance = { apiHead: source.head_sha, checkedRevision: checked.length === 1 ? checked[0] : null,
      checkoutObservations: jobs.filter(job => job.logs.checkoutRevisions.length).map(job => ({ job: job.id, revisions: job.logs.checkoutRevisions, source: job.logs.source })),
      approvesCurrentTarget: false, recordedTarget: null, currentTarget: { available: false, reason: "no-recorded-target" },
      scope: selected.length === 1 ? { status: "log-observed", plan: selected[0].logs.selection, source: selected[0].logs.source } : { status: "unverified", reason: "scope-evidence-unavailable" } };

    corroborate(root, source, rawJobs, jobs, provenance, artifacts);
    currentTarget(root, source, provenance);
    if (!artifactsAvailable) provenance.artifact = { status: "unavailable", reason: "artifacts-unavailable" };
    attempts.push({ attempt, source: route, status: source.status, conclusion: source.conclusion,
      createdAt: source.created_at, runStartedAt: source.run_started_at, updatedAt: source.updated_at, lifecycleSeconds: seconds(source.created_at, source.updated_at),
      ...timing(jobs, source.created_at, source.status), provenance, observedWork: observedWork(jobs), jobs });
  }
  const after = api(`${root}/actions/runs/${id}`);
  if (after.id !== run.id || after.run_attempt !== run.run_attempt || after.head_sha !== run.head_sha || after.status !== run.status || after.conclusion !== run.conclusion) throw new Error("Run changed during collection; collect a stable snapshot again.");
  const complete = attempts.every(attempt => attempt.complete);
  return {
    id: run.id, repository, workflow: run.name, url: run.html_url, event: run.event,
    revision: run.head_sha, status: run.status, conclusion: run.conclusion, collectedAt: new Date().toISOString(),
    actualBilling: "unavailable", rounding: "Timestamp estimate: each actually started job rounds up to minutes, minimum one; no pricing or allowance adjustment.",
    attempts,
    totals: {
      complete,
      elapsedToLastCompletionSeconds: complete ? seconds(attempts[0].createdAt, attempts.at(-1).completedAt) : null,
      lifecycleElapsedSeconds: seconds(attempts[0].createdAt, attempts.at(-1).updatedAt),
      runnerSeconds: complete ? attempts.reduce((sum, attempt) => sum + attempt.runnerSeconds, 0) : null,
      roundedJobMinutes: complete ? attempts.reduce((sum, attempt) => sum + attempt.roundedJobMinutes, 0) : null,
      observedRunnerSeconds: attempts.reduce((sum, attempt) => sum + attempt.observedRunnerSeconds, 0),
      observedRoundedJobMinutes: attempts.reduce((sum, attempt) => sum + attempt.observedRoundedJobMinutes, 0),
    },
  };
}

try {
  const ids = process.argv.slice(2);
  if (!ids.length || ids.some(id => !/^\d+$/.test(id) || !positive(Number(id)))) throw new Error("Usage: node scripts/ci-timings.mjs RUN_ID... (positive numeric GitHub run IDs)");
  const repository = JSON.parse(command(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository identity");
  console.log(JSON.stringify(ids.map(id => reportRun(repository, id)), null, 2));
} catch (error) {
  console.error(error.status ? "GitHub timing evidence unavailable; collection did not complete." : error.message);
  process.exitCode = 1;
}
