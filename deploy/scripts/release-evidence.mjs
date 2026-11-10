import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertPublicBuild } from "./release-bundle.mjs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { resolveReleaseRevision } from "./release-policy.mjs";
import { verificationPlan } from "../../scripts/ci-policy.mjs";

export const CANDIDATE_WORKFLOW = "release-verification.yml";
const positive = value => Number.isSafeInteger(value) && value > 0;
const same = isDeepStrictEqual;
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const successful = value => value?.status === "completed" && value.conclusion === "success";
const requiredSteps = {
  "CI profile": ["Select verification plan"],
  tracker: ["Agent tracker command behavior", "Agent tracker through real gh and controlled GitHub HTTP"],
  common: ["Application shard coverage and measured allocation", "package-lock.json matches package.json", "Typecheck", "Lint"],
  release: ["Release policy, bundle integrity, transport and host preflight"],
  "full (1)": ["Complete application shard", "Generated database types match the migrations"],
  "full (2)": ["Complete application shard"], "full (3)": ["Complete application shard"],
  acceptance: ["Production HTTP acceptance"], check: ["Enforce verification gate"], e2e: ["Enforce verification gate"],
  "Deployment profile": ["Select verification plan"],
  runtime: ["Build the production images", "Boot the production runtime with local-only test access", "Re-running migrations preserves the deployment", "Application behavior against self-hosted Supabase", "Production web through the reverse proxy", "Runtime source retains the same immutable generator identity", "EPO schema and XML runtime assets in the production image"],
  "self-hosted": ["Enforce verification gate"],
};

export function assertCandidate(candidate) {
  const keys = ["schemaVersion", "purpose", "repository", "revision", "tag", "targetRevision", "sourceTree", "policyDigest", "publicBuild", "platform", "runHead", "sourceRef", "requestId", "requestedAt", "inputsDigest", ...(candidate?.purpose === "acceptance" ? ["acceptanceRunId"] : [])];
  if (!candidate || Object.keys(candidate).sort().join(",") !== keys.sort().join(",")) throw new Error("Invalid candidate verification schema.");
  if (!["release", "acceptance"].includes(candidate?.purpose) || candidate?.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/.test(candidate.repository) ||
      ![candidate.revision, candidate.targetRevision, candidate.sourceTree, candidate.runHead].every(value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value)) ||
      ![candidate.policyDigest, candidate.inputsDigest].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) ||
      !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(candidate.tag) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(candidate.requestId) ||
      !timestamp(candidate.requestedAt) || candidate.platform !== "linux/amd64" ||
      (candidate.purpose === "release" ? candidate.runHead !== candidate.revision || candidate.sourceRef !== `refs/tags/${candidate.tag}` :
        !positive(candidate.acceptanceRunId) || !/^refs\/pull\/[1-9]\d*\/merge$/.test(candidate.sourceRef))) throw new Error("Invalid candidate verification inputs.");
  assertPublicBuild(candidate.publicBuild);
  if (inputDigest(candidate) !== candidate.inputsDigest) throw new Error("Invalid candidate verification input digest.");
  return candidate;
}

function assertRun(run, expected) {
  if (!positive(run?.id) || !positive(run.run_attempt) || run.event !== (expected.purpose === "release" ? "workflow_dispatch" : "pull_request") ||
      run.head_sha !== expected.runHead || run.path !== `.github/workflows/${expected.purpose === "release" ? CANDIDATE_WORKFLOW : "release-verification-acceptance.yml"}` ||
      run.repository?.full_name?.toLowerCase() !== expected.repository || !positive(run.repository.id) ||
      run.head_repository?.full_name?.toLowerCase() !== expected.repository || run.head_repository.id !== run.repository.id ||
      (expected.purpose === "release" ? run.display_title !== `Release verification ${expected.requestId}` : run.id !== expected.acceptanceRunId) || !successful(run) ||
      !timestamp(run.run_started_at) || !timestamp(run.created_at) || (expected.purpose === "release" && Date.parse(run.created_at) < Date.parse(expected.requestedAt))) {
    throw new Error("Invalid or incomplete candidate verification run.");
  }
  for (const file of ["ci.yml", "deployment-check.yml", ...(expected.purpose === "acceptance" ? [CANDIDATE_WORKFLOW] : [])]) {
    const references = run.referenced_workflows?.filter(item => item.path?.toLowerCase() === `${expected.repository}/.github/workflows/${file}@${expected.sourceRef}`);
    if (references?.length !== 1 || references[0].sha !== expected.revision) throw new Error("Candidate verification used different workflow source.");
  }
}
function assertArtifact(artifact, run, expected, now = Date.now()) {
  if (!positive(artifact?.id) || artifact.name !== `release-verification-${run.id}-${run.run_attempt}` ||
      artifact.expired !== false || !timestamp(artifact.expires_at) || Date.parse(artifact.expires_at) <= now ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) || artifact.workflow_run?.id !== run.id ||
      artifact.workflow_run.repository_id !== run.repository.id || artifact.workflow_run.head_repository_id !== run.repository.id ||
      artifact.workflow_run.head_sha !== expected.runHead) throw new Error("Invalid or expired candidate verification artifact.");
}
function validReceipt(receipt) {
  return positive(receipt?.runId) && positive(receipt.runAttempt) && positive(receipt.artifactId) && /^sha256:[a-f0-9]{64}$/.test(receipt.artifactDigest);
}

// The aggregate is only an entry condition. Every selected suite and its actual
// execution step must be present in the same completed candidate attempt.
export function validateCandidateEvidence({ run, proof, jobs, artifact }, expected, now = Date.now()) {
  assertCandidate(expected);
  assertRun(run, expected);
  if (!proof || Object.keys(proof).sort().join(",") !== [...Object.keys(expected), "runId", "runAttempt", "plan", "results"].sort().join(",") || Object.keys(expected).some(key => !same(proof[key], expected[key])) ||
      proof.runId !== run.id || proof.runAttempt !== run.run_attempt ||
      !same(proof.plan, candidatePlan(expected)) ||
      !same(proof.results, { application: "success", deployment: "success" })) {
    throw new Error("Invalid candidate verification scope, policy or inputs.");
  }
  assertArtifact(artifact, run, expected, now);
  if (!Array.isArray(jobs) || new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error("Incomplete candidate verification jobs.");
  for (const [name, steps] of Object.entries(requiredSteps)) {
    const matches = jobs.filter(job => job.name === name || job.name?.endsWith(` / ${name}`));
    const job = matches[0];
    if (matches.length !== 1 || !positive(job.id) || job.run_id !== run.id || job.head_sha !== expected.runHead ||
        !successful(job) || !timestamp(job.started_at) || !timestamp(job.completed_at) ||
        Date.parse(job.started_at) < Date.parse(run.run_started_at) || Date.parse(job.completed_at) < Date.parse(job.started_at)) {
      throw new Error(`Candidate verification did not complete required suite: ${name}.`);
    }
    for (const step of steps) {
      const matches = job.steps?.filter(item => item.name === step);
      const executed = matches?.[0];
      if (matches?.length !== 1 || !successful(executed) || !timestamp(executed.started_at) || !timestamp(executed.completed_at) ||
          Date.parse(executed.started_at) < Date.parse(job.started_at) || Date.parse(executed.completed_at) < Date.parse(executed.started_at) ||
          Date.parse(executed.completed_at) > Date.parse(job.completed_at)) throw new Error(`Candidate verification did not execute required step: ${name}: ${step}.`);
    }
  }
  return { runId: run.id, runAttempt: run.run_attempt, artifactId: artifact.id, artifactDigest: artifact.digest };
}

const sha256 = value => createHash("sha256").update(value).digest("hex");
const MAX_BYTES = 1024 * 1024;

async function boundedBytes(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("Candidate verification response exceeds the size bound.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function githubClient({ repository, token, apiUrl = "https://api.github.com", deadline }) {
  if (!token) throw new Error("GH_TOKEN is required for GitHub candidate verification.");
  const base = new URL(apiUrl);
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && base.hostname === "127.0.0.1"))) throw new Error("Invalid candidate verification API origin.");
  const prefix = `${apiUrl.replace(/\/$/, "")}/repos/${repository}`;
  async function request(url, { method = "GET", body, authenticated = true, redirect = "error" } = {}) {
    let response;
    try {
      response = await fetch(url, {
        method, redirect, headers: authenticated ? { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2026-03-10", ...(body ? { "Content-Type": "application/json" } : {}) } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))),
      });
    } catch { throw new Error("GitHub candidate verification request failed or timed out."); }
    if (!response.ok && response.status !== 302) throw new Error(`GitHub candidate verification request failed (HTTP ${response.status}).`);
    return response;
  }
  async function json(endpoint, options) {
    const response = await request(prefix + endpoint, options);
    if (response.status === 204) return;
    try { return JSON.parse((await boundedBytes(response)).toString("utf8")); }
    catch { throw new Error("Invalid GitHub candidate verification JSON response."); }
  }
  async function list(endpoint, key, parameters = {}) {
    const values = [];
    let total;
    for (let page = 1; page <= 100; page++) {
      const query = new URLSearchParams({ ...parameters, per_page: "100", page: String(page) });
      const body = await json(`${endpoint}?${query}`);
      if (!Array.isArray(body?.[key]) || !Number.isSafeInteger(body.total_count) || body.total_count < 0 ||
          (total !== undefined && total !== body.total_count)) throw new Error("Incomplete GitHub candidate verification pagination.");
      total = body.total_count;
      values.push(...body[key]);
      if (values.length === total) return values;
      if (!body[key].length || values.length > total) break;
    }
    throw new Error("Incomplete GitHub candidate verification pagination.");
  }
  async function proof(artifact) {
    const response = await request(`${prefix}/actions/artifacts/${artifact.id}/zip`, { redirect: "manual" });
    if (response.status !== 302) throw new Error("Missing candidate verification artifact redirect.");
    let location;
    try { location = new URL(response.headers.get("location")); } catch { throw new Error("Invalid candidate verification artifact location."); }
    if (location.username || location.password ||
        (location.protocol !== "https:" && !(base.protocol === "http:" && location.origin === base.origin))) throw new Error("Invalid candidate verification artifact location.");
    // Signed artifact storage URLs receive no GitHub credential, including in a
    // same-origin fixture. The digest covers exactly the downloaded ZIP bytes.
    const bytes = await boundedBytes(await request(location, { authenticated: false }));
    if (`sha256:${sha256(bytes)}` !== artifact.digest) throw new Error("Candidate verification artifact digest mismatch.");
    const temporary = await mkdtemp(path.join(tmpdir(), "ivat-release-evidence-"));
    try {
      const archive = path.join(temporary, "evidence.zip");
      await writeFile(archive, bytes);
      const options = { encoding: "utf8", maxBuffer: MAX_BYTES, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] };
      if (execFileSync("unzip", ["-Z1", archive], options).trim() !== "release-evidence.json") throw new Error("Invalid candidate verification archive inventory.");
      return JSON.parse(execFileSync("unzip", ["-p", archive, "release-evidence.json"], options));
    } catch { throw new Error("Invalid candidate verification evidence archive."); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
  return { json, list, proof };
}

async function assertCurrentCandidate(client, candidate) {
  const target = await client.json(`/commits/${encodeURIComponent("heads/main")}`);
  const sourceRef = candidate.purpose === "release" ? `tags/${candidate.tag}` : candidate.revision;
  const source = await client.json(`/commits/${encodeURIComponent(sourceRef)}`);
  if (target?.sha !== candidate.targetRevision) throw new Error("Candidate verification target changed; select and verify current inputs again.");
  if (source?.sha !== candidate.revision || source.commit?.tree?.sha !== candidate.sourceTree) throw new Error("Candidate verification tag or source changed.");
}

export async function waitForCandidateVerification({ candidate, token, apiUrl, runId, timeoutMs = 60 * 60_000, pollMs = 10_000 }) {
  assertCandidate(candidate);
  const deadline = Date.now() + timeoutMs;
  const client = githubClient({ repository: candidate.repository, token, apiUrl, deadline });
  await assertCurrentCandidate(client, candidate);
  while (Date.now() < deadline) {
    const runs = candidate.purpose === "acceptance" || positive(runId) ? [await client.json(`/actions/runs/${candidate.purpose === "acceptance" ? candidate.acceptanceRunId : runId}`)] :
      await client.list(`/actions/workflows/${CANDIDATE_WORKFLOW}/runs`, "workflow_runs", { head_sha: candidate.revision, event: "workflow_dispatch" });
    const matches = candidate.purpose === "acceptance" ? runs : runs.filter(run => run.display_title === `Release verification ${candidate.requestId}`);
    if (positive(runId) && matches.length !== 1) throw new Error("Dispatched candidate verification identity differs from its request.");
    if (matches.length > 1) throw new Error("Ambiguous candidate verification request; inspect its runs before retrying.");
    if (matches.length) {
      const latest = await client.json(`/actions/runs/${matches[0].id}`);
      if (!positive(latest.id) || !positive(latest.run_attempt)) throw new Error("Invalid candidate verification attempt identity.");
      const run = await client.json(`/actions/runs/${latest.id}/attempts/${latest.run_attempt}`);
      if (run.id !== latest.id || run.run_attempt !== latest.run_attempt) throw new Error("Candidate verification attempt changed.");
      if (run.status === "completed") {
        if (run.conclusion !== "success") throw new Error(`Candidate verification did not succeed (${run.conclusion}).`);
        const jobs = await client.list(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs");
        const artifacts = await client.list(`/actions/runs/${run.id}/artifacts`, "artifacts");
        const selected = artifacts.filter(item => item.name === `release-verification-${run.id}-${run.run_attempt}`);
        if (selected.length !== 1) throw new Error("Missing or ambiguous candidate verification artifact.");
        const artifact = selected[0];
        const proof = await client.proof(artifact);
        const receipt = validateCandidateEvidence({ run, jobs, artifact, proof }, candidate);
        // Corroborate the current attempt and ref facts again after downloading:
        // a rerun or moved target cannot inherit an earlier success.
        const current = await client.json(`/actions/runs/${run.id}`);
        if (current.id !== run.id || current.run_attempt !== run.run_attempt || !successful(current)) throw new Error("Candidate verification attempt changed.");
        assertRun(current, candidate);
        await assertCurrentCandidate(client, candidate);
        return receipt;
      }
    }
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error("Timed out waiting for complete candidate verification; preserve the request and resume after inspecting its run.");
}

export async function dispatchCandidateVerification({ candidate, token, apiUrl }) {
  assertCandidate(candidate);
  if (candidate.purpose !== "release") throw new Error("Acceptance evidence cannot request production release verification.");
  const client = githubClient({ repository: candidate.repository, token, apiUrl, deadline: Date.now() + 30_000 });
  await assertCurrentCandidate(client, candidate);
  const acknowledgement = await client.json(`/actions/workflows/${CANDIDATE_WORKFLOW}/dispatches`, {
    method: "POST", body: { ref: candidate.tag, inputs: { candidate: JSON.stringify(candidate), requestId: candidate.requestId } },
  });
  if (!positive(acknowledgement?.workflow_run_id)) throw new Error("Missing candidate dispatch run identity; preserve the request and inspect before retrying.");
  return acknowledgement.workflow_run_id;
}

function candidatePlan(candidate) {
  return verificationPlan({ event: candidate.purpose === "release" ? "workflow_dispatch" : "pull_request", fullVerification: true });
}
function inputDigest(candidate) {
  const { revision, sourceTree, tag, platform } = candidate;
  const publicBuild = { supabaseUrl: candidate.publicBuild?.supabaseUrl, publishableKey: candidate.publicBuild?.publishableKey };
  return sha256(JSON.stringify({ revision, sourceTree, tag, publicBuild, platform }));
}
const policyFiles = [".github/workflows/ci.yml", ".github/workflows/deployment-check.yml", ".github/workflows/release-verification.yml", "scripts/ci-policy.mjs", "deploy/scripts/release-evidence.mjs"];
function git(directory, ...args) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function policyDigest(directory, revision) {
  const hash = createHash("sha256");
  for (const file of policyFiles) {
    hash.update(file + "\0");
    hash.update(execFileSync("git", ["show", `${revision}:${file}`], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] }));
    hash.update("\0");
  }
  return hash.digest("hex");
}
export function createCandidate({ repository, revision, tag, publicBuild, directory = process.cwd(), purpose = "release", runHead = revision, sourceRef = `refs/tags/${tag}`, acceptanceRunId }) {
  assertPublicBuild(publicBuild);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid candidate revision.");
  const targetRevision = git(directory, "rev-parse", "refs/remotes/origin/main");
  if (purpose === "release") resolveReleaseRevision(tag, revision, directory);
  const policy = policyDigest(directory, revision);
  if (purpose === "release" && policy !== policyDigest(directory, targetRevision)) throw new Error("Candidate policy differs from the trusted main policy; select a current candidate.");
  const candidate = {
    schemaVersion: 1, purpose, repository: repository?.toLowerCase(), revision, tag, targetRevision,
    sourceTree: git(directory, "rev-parse", `${revision}^{tree}`), policyDigest: policy,
    publicBuild, platform: "linux/amd64", runHead, sourceRef,
    requestId: randomUUID(), requestedAt: new Date().toISOString(),
    ...(purpose === "acceptance" ? { acceptanceRunId } : {}),
  };
  candidate.inputsDigest = inputDigest(candidate);
  return assertCandidate(candidate);
}
export function assertCandidateSource(candidate, directory = process.cwd()) {
  assertCandidate(candidate);
  if (git(directory, "rev-parse", "refs/remotes/origin/main") !== candidate.targetRevision) throw new Error("Candidate target changed.");
  if (git(directory, "rev-parse", "HEAD") !== candidate.revision || git(directory, "rev-parse", "HEAD^{tree}") !== candidate.sourceTree) throw new Error("Candidate checkout differs from the selected source.");
  if (policyDigest(directory, "HEAD") !== candidate.policyDigest) throw new Error("Candidate verification policy changed.");
  if (candidate.purpose === "release") {
    resolveReleaseRevision(candidate.tag, candidate.revision, directory);
    if (policyDigest(directory, candidate.targetRevision) !== candidate.policyDigest) throw new Error("Candidate policy differs from trusted main.");
  }
  return candidate;
}

export function produceCandidateEvidence(candidate, producer, directory = process.cwd()) {
  assertCandidateSource(candidate, directory);
  if (producer.repository?.toLowerCase() !== candidate.repository || producer.revision !== candidate.revision ||
      producer.sourceRef !== candidate.sourceRef || producer.event !== (candidate.purpose === "release" ? "workflow_dispatch" : "pull_request") ||
      !positive(producer.runId) || !positive(producer.runAttempt) ||
      (candidate.purpose === "acceptance" && producer.runId !== candidate.acceptanceRunId)) throw new Error("Producer identity differs from the candidate.");
  if (producer.application !== "success" || producer.deployment !== "success") throw new Error("Candidate verification did not complete successfully.");
  return { ...candidate, runId: producer.runId, runAttempt: producer.runAttempt, plan: candidatePlan(candidate), results: { application: "success", deployment: "success" } };
}

export async function confirmCandidate({ candidate, receipt, token, apiUrl }) {
  assertCandidate(candidate);
  if (!validReceipt(receipt)) throw new Error("Missing completed candidate verification receipt.");
  const client = githubClient({ repository: candidate.repository, token, apiUrl, deadline: Date.now() + 30_000 });
  await assertCurrentCandidate(client, candidate);
  const run = await client.json(`/actions/runs/${receipt.runId}`);
  if (run.id !== receipt.runId || run.run_attempt !== receipt.runAttempt) throw new Error("Candidate verification attempt changed since approval.");
  assertRun(run, candidate);
  const attempt = await client.json(`/actions/runs/${receipt.runId}/attempts/${receipt.runAttempt}`);
  if (attempt.id !== receipt.runId || attempt.run_attempt !== receipt.runAttempt) throw new Error("Candidate verification attempt changed since approval.");
  assertRun(attempt, candidate);
  const artifacts = await client.list(`/actions/runs/${receipt.runId}/artifacts`, "artifacts");
  const selected = artifacts.filter(item => item.id === receipt.artifactId);
  if (selected.length !== 1 || selected[0].digest !== receipt.artifactDigest) throw new Error("Candidate verification artifact changed or was deleted.");
  assertArtifact(selected[0], run, candidate);
  // The unchanged immutable ZIP digest preserves the previously inspected
  // full-suite proof. A different attempt/artifact must undergo collection again.
  const current = await client.json(`/actions/runs/${receipt.runId}`);
  if (current.id !== receipt.runId || current.run_attempt !== receipt.runAttempt) throw new Error("Candidate verification attempt changed since approval.");
  assertRun(current, candidate);
  await assertCurrentCandidate(client, candidate);
}

export function assertReleaseEvidenceInputs(release, publicBuild, directory = process.cwd()) {
  const candidate = assertCandidate(release.verification?.candidate);
  const receipt = release.verification?.receipt;
  if (candidate.purpose !== "release" || candidate.repository !== release.repository || candidate.revision !== release.revision || candidate.tag !== release.tag ||
      !same(candidate.publicBuild, publicBuild) || git(directory, "rev-parse", "HEAD") !== candidate.revision ||
      git(directory, "rev-parse", "HEAD^{tree}") !== candidate.sourceTree || !validReceipt(receipt)) throw new Error("Release source or public build inputs differ from the completed candidate verification.");
  return candidate;
}

async function main() {
  const [command, file] = process.argv.slice(2);
  if (command === "identity" || command === "produce") {
    let candidate;
    if (process.env.CANDIDATE) {
      candidate = JSON.parse(process.env.CANDIDATE);
      assertCandidateSource(candidate);
      if (candidate.purpose === "release" ? process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.REQUEST_ID !== candidate.requestId :
          command !== "produce" || process.env.GITHUB_EVENT_NAME !== "pull_request") throw new Error("Candidate dispatch request differs from selected inputs.");
    } else {
      if (process.env.GITHUB_EVENT_NAME !== "pull_request") throw new Error("Only an explicit PR acceptance caller may omit a release request.");
      const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
      candidate = createCandidate({
        repository: process.env.GITHUB_REPOSITORY, revision: process.env.GITHUB_SHA, tag: "v0.0.0", purpose: "acceptance",
        runHead: event.pull_request?.head?.sha, sourceRef: process.env.GITHUB_REF, acceptanceRunId: Number(process.env.GITHUB_RUN_ID),
        publicBuild: { supabaseUrl: "https://api.ivat.invalid", publishableKey: "sb_publishable_acceptance" },
      });
      if (candidate.targetRevision !== event.pull_request?.base?.sha || event.repository?.full_name?.toLowerCase() !== candidate.repository) throw new Error("Acceptance target or repository differs from the PR event.");
    }
    if (command === "identity") {
      await writeFile(file, JSON.stringify(candidate, null, 2) + "\n", { flag: "wx" });
      if (process.env.GITHUB_OUTPUT) {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(process.env.GITHUB_OUTPUT, `candidate=${JSON.stringify(candidate)}\npublic-build=${JSON.stringify(candidate.publicBuild)}\ntag=${candidate.tag}\n`);
      }
    } else {
      const proof = produceCandidateEvidence(candidate, {
        repository: process.env.GITHUB_REPOSITORY, revision: process.env.GITHUB_SHA, sourceRef: process.env.GITHUB_REF,
        event: process.env.GITHUB_EVENT_NAME, runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        application: process.env.APPLICATION_RESULT, deployment: process.env.DEPLOYMENT_RESULT,
      });
      await writeFile(file, JSON.stringify(proof, null, 2) + "\n", { flag: "wx" });
    }
  } else if (command === "build-runtime") {
    const publicBuild = process.env.CANDIDATE_PUBLIC_BUILD ? JSON.parse(process.env.CANDIDATE_PUBLIC_BUILD) : null;
    if (publicBuild) assertPublicBuild(publicBuild);
    execFileSync("docker", ["compose", "--env-file", ".env.rosti", "-f", "docker-compose.rosti.yml", "build"], {
      stdio: "inherit", env: { ...process.env, ...(publicBuild ? { SUPABASE_PUBLIC_URL: publicBuild.supabaseUrl, ANON_KEY: publicBuild.publishableKey } : {}) },
    });
  } else if (command === "inspect-acceptance") {
    const candidate = JSON.parse(await readFile(file, "utf8"));
    if (candidate.purpose !== "acceptance") throw new Error("This command accepts non-deployable PR acceptance evidence only.");
    console.log(JSON.stringify(await waitForCandidateVerification({ candidate, token: process.env.GH_TOKEN, apiUrl: process.env.GITHUB_API_URL })));
  } else throw new Error("Usage: release-evidence.mjs identity|produce <file> | build-runtime | inspect-acceptance <request.json>");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
