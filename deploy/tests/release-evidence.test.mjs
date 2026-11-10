import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSimulation } from "./simulation-process.mjs";
import { createHash } from "node:crypto";
import { validateCandidateEvidence, waitForCandidateVerification, dispatchCandidateVerification, createCandidate, assertCandidateSource, produceCandidateEvidence, assertReleaseEvidenceInputs, confirmCandidate } from "../scripts/release-evidence.mjs";

test("a green scoped main aggregate is insufficient production release evidence", () => {
  assert.throws(() => validateCandidateEvidence({ run: { head_sha: "a".repeat(40), event: "push", status: "completed", conclusion: "success" } }, {}), /candidate|verification/i);
});

const revision = "a".repeat(40);
const expected = {
  schemaVersion: 1, purpose: "release", runHead: revision, sourceRef: "refs/tags/v0.2.0", repository: "thomisso/ivat", revision, tag: "v0.2.0", targetRevision: revision,
  sourceTree: "b".repeat(40), policyDigest: "c".repeat(64), inputsDigest: "f6268a70ea46075f09108dcd549c717b4934517cd46308d6648e8496a325af44",
  requestId: "12345678-1234-4123-8123-123456789abc", requestedAt: "2026-11-09T12:00:00Z",
  publicBuild: { supabaseUrl: "https://api.ivat.cz", publishableKey: "sb_publishable_test" }, platform: "linux/amd64",
};
const stepNames = {
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
function validEvidence() {
  const run = { id: 20, run_attempt: 1, repository: { full_name: "Thomisso/iVAT", id: 99 }, head_repository: { full_name: "Thomisso/iVAT", id: 99 }, head_sha: revision,
    path: ".github/workflows/release-verification.yml", event: "workflow_dispatch", display_title: `Release verification ${expected.requestId}`,
    status: "completed", conclusion: "success", run_started_at: "2026-11-09T12:01:00Z", created_at: "2026-11-09T12:01:00Z",
    referenced_workflows: ["ci.yml", "deployment-check.yml"].map(file => ({ path: `thomisso/ivat/.github/workflows/${file}@refs/tags/v0.2.0`, sha: revision })) };
  const proof = { ...expected, runId: 20, runAttempt: 1, plan: { version: 1, profile: "full", reason: "conservative-non-pr",
    scopes: { common: true, tracker: true, trackerTransport: true, release: true, application: true, http: true, deployment: true },
    reasons: { common: "conservative-non-pr", tracker: "conservative-non-pr", trackerTransport: "conservative-non-pr", release: "conservative-non-pr", application: "conservative-non-pr", http: "conservative-non-pr", deployment: "conservative-non-pr" } }, results: { application: "success", deployment: "success" } };
  const jobs = Object.entries(stepNames).map(([name, steps], index) => ({ id: index + 100, run_id: 20, head_sha: revision, name: `Verification / ${name}`, status: "completed", conclusion: "success", started_at: "2026-11-09T12:02:00Z", completed_at: "2026-11-09T12:10:00Z", steps: steps.map(name => ({ name, status: "completed", conclusion: "success", started_at: "2026-11-09T12:02:00Z", completed_at: "2026-11-09T12:10:00Z" })) }));
  const artifact = { id: 30, name: "release-verification-20-1", expired: false, expires_at: "2099-12-01T00:00:00Z", digest: `sha256:${"e".repeat(64)}`, workflow_run: { id: 20, repository_id: 99, head_repository_id: 99, head_sha: revision } };
  return { run, proof, jobs, artifact };
}

test("complete exact candidate evidence retains the successful run, attempt and artifact identity", () => {
  assert.deepEqual(validateCandidateEvidence(validEvidence(), expected), { runId: 20, runAttempt: 1, artifactId: 30, artifactDigest: `sha256:${"e".repeat(64)}` });
});

test("candidate verification refuses wrong provenance and every incomplete required execution", () => {
  const changes = [
    value => { value.run.repository.full_name = "other/ivat"; },
    value => { value.run.head_sha = "f".repeat(40); },
    value => { value.run.run_attempt = 2; },
    value => { value.run.path = ".github/workflows/ci.yml"; },
    value => { value.run.referenced_workflows[0].sha = "f".repeat(40); },
    value => { value.proof.targetRevision = "f".repeat(40); },
    value => { value.proof.inputsDigest = "f".repeat(64); },
    value => { value.proof.policyDigest = "f".repeat(64); },
    value => { value.proof.plan.scopes.http = false; },
    value => { value.artifact.expired = true; },
    value => { value.artifact.expires_at = "2026-01-01T00:00:00Z"; },
    value => { value.artifact.name = "release-verification-20-2"; },
    value => { value.artifact.workflow_run.repository_id = 100; },
    value => { value.jobs.pop(); },
    value => { value.jobs.push(value.jobs[0]); },
    value => { value.jobs[0].started_at = "2026-11-09T11:59:00Z"; },
    value => { delete value.jobs[7].steps[0].completed_at; },
  ];
  for (const change of changes) {
    const value = validEvidence(); change(value);
    assert.throws(() => validateCandidateEvidence(value, expected), /candidate|Candidate/);
  }
  for (const status of ["failure", "cancelled", "skipped", "neutral", "timed_out", null]) {
    for (const target of ["run", "job", "step"]) {
      const value = validEvidence();
      (target === "run" ? value.run : target === "job" ? value.jobs[7] : value.jobs[7].steps[0]).conclusion = status;
      assert.throws(() => validateCandidateEvidence(value, expected), /candidate|Candidate/);
    }
  }
});

test("malformed candidate identities cannot approve even matching self-asserted evidence", () => {
  const value = validEvidence();
  const invalid = { ...expected, policyDigest: "unknown", platform: "unknown" };
  Object.assign(value.proof, invalid);
  assert.throws(() => validateCandidateEvidence(value, invalid), /candidate|Candidate/);
  const unknown = validEvidence(); unknown.proof.unknownInput = true;
  assert.throws(() => validateCandidateEvidence(unknown, { ...expected, unknownInput: true }), /candidate|Candidate/);
});

test("the release HTTP caller verifies the exact completed attempt and artifact bytes before approval", async t => {
  const value = validEvidence();
  const directory = await mkdtemp(path.join(tmpdir(), "ivat-candidate-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "release-evidence.json"), JSON.stringify(value.proof));
  execFileSync("zip", ["-q", "proof.zip", "release-evidence.json"], { cwd: directory });
  const bytes = await readFile(path.join(directory, "proof.zip"));
  value.artifact.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const requests = [];
  let artifacts = [value.artifact];
  let target = revision;
  let dispatched;
  let broken = false;
  let origin;
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    const pathname = decodeURIComponent(new URL(request.url, origin).pathname);
    if (pathname.endsWith("/workflows/release-verification.yml/dispatches")) {
      const chunks = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => { dispatched = JSON.parse(Buffer.concat(chunks)); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ workflow_run_id: 20, run_url: `${origin}/repos/thomisso/ivat/actions/runs/20`, html_url: "https://github.com/thomisso/ivat/actions/runs/20" })); });
      return;
    }
    let body;
    if (pathname.endsWith("/commits/heads/main")) body = { sha: target };
    else if (pathname.endsWith("/commits/tags/v0.2.0")) body = { sha: revision, commit: { tree: { sha: expected.sourceTree } } };
    else if (pathname.endsWith("/workflows/release-verification.yml/runs")) body = { total_count: 1, workflow_runs: [value.run] };
    else if (pathname.endsWith("/runs/20/attempts/1/jobs")) body = { total_count: value.jobs.length, jobs: value.jobs };
    else if (pathname.endsWith("/runs/20/artifacts")) body = { total_count: artifacts.length, artifacts };
    else if (pathname.endsWith("/runs/20") || pathname.endsWith("/runs/20/attempts/1")) body = value.run;
    else if (pathname.endsWith("/artifacts/30/zip")) { response.writeHead(302, { Location: `${origin}/download` }); return response.end(); }
    else if (pathname === "/download") { response.writeHead(200); return response.end(broken ? Buffer.from("tampered") : bytes); }
    else { response.writeHead(501); return response.end(); }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  origin = `http://127.0.0.1:${server.address().port}`;
  const options = { candidate: expected, token: "disposable-test-token", apiUrl: origin, timeoutMs: 1000, pollMs: 1 };
  const runId = await dispatchCandidateVerification(options);
  assert.equal(runId, 20);
  assert.deepEqual(dispatched, { ref: "v0.2.0", inputs: { candidate: JSON.stringify(expected), requestId: expected.requestId } });
  const receipt = await waitForCandidateVerification({ ...options, runId });
  assert.equal(receipt.artifactId, 30);
  assert.ok(requests.some(item => item.path.endsWith("/commits/heads%2Fmain")));
  assert.ok(requests.some(item => item.path.endsWith("/commits/tags%2Fv0.2.0")));
  assert.ok(requests.some(item => item.path.includes("/attempts/1/jobs?per_page=100&page=1")));
  assert.equal(requests.find(item => item.path === "/download").authorization, undefined);
  await confirmCandidate({ ...options, receipt });
  value.run.run_attempt = 2;
  await assert.rejects(confirmCandidate({ ...options, receipt }), /attempt/i);
  value.run.run_attempt = 1;
  value.artifact.expired = true;
  await assert.rejects(confirmCandidate({ ...options, receipt }), /artifact/i);
  value.artifact.expired = false;
  artifacts = [];
  await assert.rejects(confirmCandidate({ ...options, receipt }), /artifact/i);
  artifacts = [value.artifact];
  value.run.conclusion = "failure";
  await assert.rejects(confirmCandidate({ ...options, receipt }), /verification run/i);
  value.run.conclusion = "success";
  broken = true;
  await assert.rejects(waitForCandidateVerification(options), /digest/i);
  broken = false; target = "f".repeat(40);
  await assert.rejects(waitForCandidateVerification(options), /target/i);
});

test("candidate selection binds tagged source, current target, policy and exact public image inputs", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "ivat-candidate-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Release test"); git("config", "user.email", "release@example.test");
  for (const file of [".github/workflows/ci.yml", ".github/workflows/deployment-check.yml", ".github/workflows/release-verification.yml", "scripts/ci-policy.mjs", "deploy/scripts/release-evidence.mjs"]) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await writeFile(path.join(directory, file), "reviewed policy\n");
  }
  git("add", "."); git("commit", "-m", "reviewed source"); git("tag", "v0.2.0");
  const source = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", source);
  const options = { repository: "thomisso/ivat", revision: source, tag: "v0.2.0", publicBuild: expected.publicBuild, directory };
  const candidate = createCandidate(options);
  assert.equal(candidate.revision, source); assert.equal(candidate.targetRevision, source); assert.equal(candidate.platform, "linux/amd64");
  assertCandidateSource(candidate, directory);
  const producer = { repository: "thomisso/ivat", revision: source, sourceRef: "refs/tags/v0.2.0", event: "workflow_dispatch", runId: 20, runAttempt: 1, application: "success", deployment: "success" };
  assert.equal(produceCandidateEvidence(candidate, producer, directory).runAttempt, 1);
  const verified = { repository: candidate.repository, revision: candidate.revision, tag: candidate.tag, verification: { candidate, receipt: { runId: 20, runAttempt: 1, artifactId: 30, artifactDigest: `sha256:${"e".repeat(64)}` } } };
  assert.equal(assertReleaseEvidenceInputs(verified, expected.publicBuild, directory).revision, source);
  assert.throws(() => assertReleaseEvidenceInputs(verified, { ...expected.publicBuild, publishableKey: "sb_publishable_changed" }, directory), /inputs/);
  assert.throws(() => assertReleaseEvidenceInputs({ ...verified, verification: { ...verified.verification, candidate: { ...candidate, purpose: "acceptance", sourceRef: "refs/pull/12/merge", acceptanceRunId: 20 } } }, expected.publicBuild, directory), /inputs/);
  const output = path.join(directory, "produced-evidence.json");
  execFileSync(process.execPath, [path.resolve("deploy/scripts/release-evidence.mjs"), "produce", output], { cwd: directory, env: {
    ...process.env, CANDIDATE: JSON.stringify(candidate), REQUEST_ID: candidate.requestId,
    GITHUB_REPOSITORY: "Thomisso/iVAT", GITHUB_SHA: source, GITHUB_REF: "refs/tags/v0.2.0", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_RUN_ID: "20", GITHUB_RUN_ATTEMPT: "1", APPLICATION_RESULT: "success", DEPLOYMENT_RESULT: "success",
  } });
  assert.equal(JSON.parse(await readFile(output, "utf8")).inputsDigest, candidate.inputsDigest);
  const eventFile = path.join(directory, "release-event.json");
  await writeFile(eventFile, JSON.stringify({ action: "published", repository: { full_name: "Thomisso/iVAT" }, release: { id: 42, tag_name: "v0.2.0", draft: false, prerelease: false } }));
  const verifiedFile = path.join(directory, "verified-release.json");
  const interrupted = spawnSync(process.execPath, [path.resolve("deploy/scripts/prepare-release.mjs"), "verify", verifiedFile], { cwd: directory, encoding: "utf8", env: {
    ...process.env, GH_TOKEN: "", GITHUB_REPOSITORY: "Thomisso/iVAT", GITHUB_EVENT_NAME: "release", GITHUB_EVENT_PATH: eventFile, GITHUB_SHA: source,
    ROSTI_PUBLIC_SUPABASE_URL: expected.publicBuild.supabaseUrl, ROSTI_PUBLIC_SUPABASE_KEY: expected.publicBuild.publishableKey,
  } });
  assert.equal(interrupted.status, 1); assert.match(interrupted.stderr, /GH_TOKEN/);
  const retained = JSON.parse(await readFile(verifiedFile + ".request.json", "utf8"));
  assert.equal(retained.candidate.revision, source); assert.equal(retained.releaseId, 42);
  await assert.rejects(readFile(verifiedFile), { code: "ENOENT" });
  assert.throws(() => produceCandidateEvidence(candidate, { ...producer, deployment: "skipped" }, directory), /complete|succeed/);
  assert.throws(() => produceCandidateEvidence(candidate, { ...producer, revision: "f".repeat(40) }, directory), /identity/);
  const otherBuild = createCandidate({ ...options, publicBuild: { ...expected.publicBuild, publishableKey: "sb_publishable_other" } });
  assert.notEqual(otherBuild.inputsDigest, candidate.inputsDigest);
  await writeFile(path.join(directory, "README.md"), "docs only\n"); git("add", "."); git("commit", "-m", "docs only");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  assert.throws(() => assertCandidateSource(candidate, directory), /target/);
  const current = createCandidate(options);
  assert.equal(current.revision, source); assert.notEqual(current.targetRevision, source);
  await writeFile(path.join(directory, "scripts/ci-policy.mjs"), "changed policy\n"); git("add", "."); git("commit", "-m", "policy changed");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  assert.throws(() => createCandidate(options), /policy/);
});

test("pre-main reusable PR proof validates its checked merge separately from its raw head and cannot authorize release", async () => {
  const value = validEvidence();
  const candidate = { ...expected, purpose: "acceptance", acceptanceRunId: 20, runHead: "f".repeat(40), sourceRef: "refs/pull/12/merge" };
  Object.assign(value.proof, candidate);
  value.proof.plan.reason = "full-override";
  for (const key of Object.keys(value.proof.plan.reasons)) value.proof.plan.reasons[key] = "full-override";
  Object.assign(value.run, { head_sha: candidate.runHead, event: "pull_request", path: ".github/workflows/release-verification-acceptance.yml" });
  value.run.referenced_workflows = ["ci.yml", "deployment-check.yml", "release-verification.yml"].map(file => ({ path: `thomisso/ivat/.github/workflows/${file}@${candidate.sourceRef}`, sha: revision }));
  value.artifact.workflow_run.head_sha = candidate.runHead;
  for (const job of value.jobs) job.head_sha = candidate.runHead;
  assert.equal(validateCandidateEvidence(value, candidate).runId, 20);
  assert.throws(() => validateCandidateEvidence(value, expected), /candidate|Candidate/);
  await assert.rejects(dispatchCandidateVerification({ candidate, token: "test" }), /Acceptance/);
});

test("the real candidate HTTP caller consumes the existing Postman release simulation and refuses provider/archive failures", async t => {
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const simulation = spawnSimulation("postman/simulations/release-flow/release-flow.sim.yaml", port);
  t.after(simulation.stop);
  let log = "";
  simulation.child.stdout.on("data", chunk => { log += chunk; }); simulation.child.stderr.on("data", chunk => { log += chunk; });
  const deadline = Date.now() + 15000;
  while (!/"(?:type|event)":"listening"/.test(log)) {
    if (Date.now() > deadline || simulation.child.exitCode !== null) throw new Error("Candidate simulation failed to start.");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const directory = await mkdtemp(path.join(tmpdir(), "ivat-candidate-simulation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = validEvidence();
  await writeFile(path.join(directory, "release-evidence.json"), JSON.stringify(evidence.proof));
  execFileSync("zip", ["-q", "proof.zip", "release-evidence.json"], { cwd: directory });
  const archive = await readFile(path.join(directory, "proof.zip"));
  evidence.artifact.digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  const apiUrl = `http://127.0.0.1:${port}/github`;
  const candidateState = { candidate: expected, evidence, archiveBase64: archive.toString("base64"), downloadUrl: `${apiUrl}/candidate-archive` };
  const control = async behavior => {
    const response = await fetch(apiUrl + "/__control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ behavior, revision, candidateState }) });
    assert.equal(response.status, 200);
  };
  const options = { candidate: expected, token: "PRIVATE_TEST_TOKEN", apiUrl, timeoutMs: 1000, pollMs: 1 };
  await control("success");
  await dispatchCandidateVerification(options);
  assert.equal((await waitForCandidateVerification(options)).artifactId, 30);
  for (const behavior of ["wrong-target", "tampered", "forbidden", "html", "malformed"]) {
    await control(behavior);
    await assert.rejects(waitForCandidateVerification(options), error => {
      assert.doesNotMatch(error.message, /PRIVATE_/); return /target|digest|GitHub/.test(error.message);
    }, behavior);
  }
  assert.match(log, /release-verification\.yml/);
  assert.match(log, /attempts\/1\/jobs/);
  assert.match(log, /candidate-archive/);
});
