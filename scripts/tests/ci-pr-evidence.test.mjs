import assert from "node:assert/strict";
import test from "node:test";
import * as evidencePolicy from "../ci-pr-evidence.mjs";
import { verificationPlan } from "../ci-policy.mjs";

function fixture(workflow = "ci.yml") {
  const context = { repository: "acme/ivat", headRepository: "acme/ivat", workflow, workflowId: 7, runId: 20, runAttempt: 1, pr: 3, head: "a".repeat(40), checked: "b".repeat(40), target: "main", targetSha: "c".repeat(40), policy: "d".repeat(64) };
  const plan = verificationPlan({ event: "pull_request", fullVerification: true, files: ["README.md"] });
  const results = { policy: "success", common: "success", tracker: "success", trackerTransport: "success", release: "success", application: "success", http: "success", deployment: "success" };
  const proof = evidencePolicy.recordPrEvidence({ context, plan, results });
  const run = { id: 20, run_attempt: 1, workflow_id: 7, event: "pull_request", status: "completed", conclusion: "success", path: `.github/workflows/${workflow}`, head_sha: context.head, repository: { full_name: context.repository }, head_repository: { full_name: context.headRepository }, pull_requests: [{ number: 3 }] };
  const names = workflow === "ci.yml" ? ["CI profile", "common", "tracker", "release", "full (1)", "full (2)", "full (3)", "acceptance", "check", "e2e", "PR verification evidence"] : ["Deployment profile", "runtime", "self-hosted", "PR verification evidence"];
  const jobs = names.map((name, index) => ({ id: index + 1, run_id: 20, head_sha: context.head, name, status: "completed", conclusion: "success" }));
  const artifact = { id: 42, name: "pr-verification-1", expired: false, digest: `sha256:${"e".repeat(64)}`, workflow_run: { id: 20, head_sha: context.head } };
  return { context: { ...context, runId: 21 }, plan: verificationPlan({ event: "pull_request", files: ["src/app/page.tsx"] }), proof, run, jobs, jobAttempt: 1, artifact };
}

test("ready verification can reuse fresh full proof of the same immutable inputs and actual successful jobs", () => {
  for (const workflow of ["ci.yml", "deployment-check.yml"]) assert.equal(evidencePolicy.reusablePrEvidence(fixture(workflow)), true);
});

export { fixture };

test("changed inputs, missing proof, reuse chains and failed or incomplete actual source jobs cannot authorize reuse", () => {
  const changes = [
    value => { value.context.head = "f".repeat(40); },
    value => { value.context.checked = "f".repeat(40); },
    value => { value.context.target = "release"; },
    value => { value.context.targetSha = "f".repeat(40); },
    value => { value.context.policy = "f".repeat(64); },
    value => { value.context.pr = 4; },
    value => { value.context.repository = "other/ivat"; },
    value => { value.context.workflowId = 8; },
    value => { value.proof = undefined; },
    value => { value.proof.fresh = false; },
    value => { value.proof.plan.profile = "draft"; },
    value => { value.proof.plan.scopes.http = false; value.proof.results.http = "skipped"; },
    value => { value.run.run_attempt = 2; },
    value => { value.run.event = "workflow_dispatch"; },
    value => { value.run.conclusion = "failure"; },
    value => { value.run.status = "in_progress"; },
    value => { value.artifact.expired = true; },
    value => { value.artifact.workflow_run.id = 99; },
    value => { value.artifact.name = "pr-verification-2"; },
    value => { delete value.artifact.digest; },
    value => { value.jobAttempt = 2; },
    value => { value.jobs.pop(); },
    value => { value.jobs.push(value.jobs[0]); },
  ];
  for (const job of ["common", "full (1)", "full (2)", "full (3)", "acceptance", "check", "e2e"]) {
    for (const conclusion of ["failure", "cancelled", "skipped", undefined]) changes.push(value => { value.jobs.find(candidate => candidate.name === job).conclusion = conclusion; });
  }
  for (const change of changes) {
    const value = fixture(); change(value);
    assert.equal(evidencePolicy.reusablePrEvidence(value), false, change.toString());
  }
  const value = fixture();
  assert.throws(() => evidencePolicy.recordPrEvidence({ context: value.proof.context, plan: value.proof.plan, results: value.proof.results, reused: true }), /fresh/);
});

test("HTTP evidence lookup refuses a newer failed attempt instead of falling back to older green proof", async t => {
  const { createServer } = await import("node:http");
  const value = fixture();
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ total_count: 2, workflow_runs: [{ ...value.run, id: 22, conclusion: "failure" }, value.run] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await evidencePolicy.findReusablePrEvidence({ context: value.context, plan: value.plan, token: "synthetic", apiUrl: `http://127.0.0.1:${server.address().port}` });
  assert.equal(result, null);
  assert.deepEqual(requests, [`/repos/acme/ivat/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${value.context.head}&per_page=100`]);
});

async function githubFixture(t, value) {
  const { createServer } = await import("node:http");
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createHash } = await import("node:crypto");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-pr-artifact-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let archive;
  const refresh = proof => {
    value.proof = proof;
    fs.writeFileSync(path.join(directory, "pr-verification.json"), JSON.stringify(proof));
    fs.rmSync(path.join(directory, "proof.zip"), { force: true });
    execFileSync("zip", ["-q", "proof.zip", "pr-verification.json"], { cwd: directory });
    archive = fs.readFileSync(path.join(directory, "proof.zip"));
    value.artifact.digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  };
  refresh(value.proof);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const json = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.headers.authorization !== "Bearer synthetic" || request.headers["x-github-api-version"] !== "2026-03-10") return json(401, {});
    if (value.httpFailure) return json(value.httpFailure, { message: "Unavailable" });
    const root = `/repos/${value.context.repository}`;
    const route = request.url;
    const source = value.proof.context;
    if (route === `${root}/pulls/${source.pr}`) return json(200, { number: source.pr, draft: value.currentDraft ?? true, labels: value.currentFull === false ? [] : [{ name: "ci:full" }], head: { sha: value.liveHead ?? source.head, repo: { full_name: source.headRepository } }, base: { ref: source.target, sha: source.targetSha, repo: { full_name: source.repository } } });
    if (route === `${root}/branches/${source.target}`) return json(200, { commit: { sha: value.liveTarget ?? source.targetSha } });
    if (route === `${root}/actions/workflows/${source.workflow}/runs?event=pull_request&head_sha=${source.head}&per_page=100`) return json(200, { total_count: value.truncatedRuns ? 101 : (value.runs ?? [value.run]).length, workflow_runs: value.runs ?? [value.run] });
    const run = route.match(/\/actions\/runs\/(\d+)$/)?.[1];
    if (run) return json(200, Number(run) === value.context.runId ? { ...value.run, id: value.context.runId, run_attempt: value.context.runAttempt } : (value.runs ?? [value.run]).find(candidate => candidate.id === Number(run)));
    if (route === `${root}/actions/runs/${source.runId}/attempts/${source.runAttempt}/jobs?per_page=100`) return json(200, { total_count: value.jobs.length, jobs: value.jobs });
    if (route === `${root}/actions/runs/${source.runId}/artifacts?per_page=100`) return json(200, { total_count: value.missingArtifact ? 0 : 1, artifacts: value.missingArtifact ? [] : [value.artifact] });
    if (/\/actions\/runs\/\d+\/attempts\/\d+\/jobs\?per_page=100$/.test(route)) return json(200, { total_count: 0, jobs: [] });
    if (/\/actions\/runs\/\d+\/artifacts\?per_page=100$/.test(route)) return json(200, { total_count: 0, artifacts: [] });
    if (route === `${root}/actions/artifacts/${value.artifact.id}/zip`) { response.writeHead(200, { "content-type": "application/zip" }); return response.end(value.corruptArchive ? Buffer.from("corrupt") : archive); }
    json(501, { message: "Endpoint not modelled" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { refresh, requests, apiUrl: `http://127.0.0.1:${server.address().port}` };
}

test("actual artifact download binds its digest, source attempt and complete selected jobs; repeated readiness retains original provenance", async t => {
  const value = fixture(); const api = await githubFixture(t, value);
  const find = () => evidencePolicy.findReusablePrEvidence({ context: value.context, plan: value.plan, token: "synthetic", apiUrl: api.apiUrl });
  assert.deepEqual(await find(), { runId: 20, runAttempt: 1, artifactId: 42 });
  assert.ok(api.requests.includes("/repos/acme/ivat/actions/runs/20/attempts/1/jobs?per_page=100"));
  assert.ok(api.requests.includes("/repos/acme/ivat/actions/artifacts/42/zip"));
  // Successful administrative/reused receipts carry no new full proof. They
  // neither replace nor turn into a chain of manufactured fresh evidence.
  value.runs = [{ ...value.run, id: 22 }, value.run];
  assert.deepEqual(await find(), { runId: 20, runAttempt: 1, artifactId: 42 });
  for (const property of ["corruptArchive", "missingArtifact", "truncatedRuns"]) {
    value[property] = true; assert.equal(await find(), null, property); delete value[property];
  }
  value.artifact.expired = true; assert.equal(await find(), null); value.artifact.expired = false;
  value.jobs.find(job => job.name === "full (2)").conclusion = "cancelled";
  assert.equal(await find(), null);
});

async function cli(command, environment, directory) {
  const { spawn } = await import("node:child_process");
  const executable = new URL(command === "gate" ? "../ci-policy.mjs" : "../ci-pr-evidence.mjs", import.meta.url).pathname;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, command], { cwd: directory, env: { PATH: process.env.PATH, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject); child.on("close", status => resolve({ status, stdout, stderr }));
  });
}

test("public select/record/gate CLIs reuse an actual checked merge, rerun on uncertainty, and fail closed when the current target changes", async t => {
  const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-pr-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main"); git("config", "user.email", "ci@example.test"); git("config", "user.name", "CI evidence fixture");
  for (const file of ["scripts/ci-policy.mjs", "scripts/ci-pr-evidence.mjs", ".github/workflows/ci.yml", ".github/workflows/deployment-check.yml"]) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.copyFileSync(new URL(`../../${file}`, import.meta.url), path.join(directory, file));
  }
  fs.writeFileSync(path.join(directory, "README.md"), "Base"); git("add", "."); git("commit", "-m", "Base");
  git("checkout", "-b", "feature"); fs.writeFileSync(path.join(directory, "application.txt"), "Change"); git("add", "."); git("commit", "-m", "Application");
  const head = git("rev-parse", "HEAD");
  git("checkout", "main"); fs.writeFileSync(path.join(directory, "README.md"), "Target advance"); git("add", "."); git("commit", "-m", "Target");
  const base = git("rev-parse", "HEAD"); git("merge", "--no-ff", "feature", "-m", "Test merge"); const checked = git("rev-parse", "HEAD");
  const value = fixture();
  for (const context of [value.context, value.proof.context]) Object.assign(context, { head, checked, targetSha: base });
  value.run.head_sha = head; value.artifact.workflow_run.head_sha = head; for (const job of value.jobs) job.head_sha = head;
  const api = await githubFixture(t, value);
  const eventFile = path.join(directory, "event.json"); const output = path.join(directory, "output");
  const pr = { number: 3, draft: true, labels: [{ name: "ci:full" }], head: { sha: head, repo: { full_name: "acme/ivat" } }, base: { sha: base, ref: "main", repo: { full_name: "acme/ivat" } } };
  const event = { action: "labeled", label: { name: "ci:full" }, repository: { full_name: "acme/ivat" }, pull_request: pr };
  fs.writeFileSync(eventFile, JSON.stringify(event)); fs.writeFileSync(output, "");
  const environment = { GH_TOKEN: "synthetic", GITHUB_API_URL: api.apiUrl, GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "acme/ivat", GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: output, GITHUB_SHA: checked, GITHUB_RUN_ID: "20", GITHUB_RUN_ATTEMPT: "1", PR_WORKFLOW_FILE: "ci.yml", PLAN: JSON.stringify(value.proof.plan), RESULTS: JSON.stringify(value.proof.results) };
  const recorded = await cli("record", environment, directory);
  assert.equal(recorded.status, 0, recorded.stderr);
  api.refresh(JSON.parse(fs.readFileSync(path.join(directory, "pr-verification.json"), "utf8")));
  value.currentDraft = false; value.currentFull = false;
  event.action = "ready_for_review"; event.pull_request.draft = false; event.pull_request.labels = []; delete event.label;
  fs.writeFileSync(eventFile, JSON.stringify(event)); environment.GITHUB_RUN_ID = "21"; environment.PLAN = JSON.stringify(value.plan);
  const selection = async () => {
    fs.writeFileSync(output, ""); const result = await cli("select", environment, directory); assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(fs.readFileSync(output, "utf8").trim().split("\n").map(line => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
  };
  const chosen = await selection();
  assert.equal(chosen.application, "false"); assert.deepEqual(JSON.parse(chosen.reuse), { runId: 20, runAttempt: 1, artifactId: 42 });
  const skipped = { policy: "success", common: "skipped", tracker: "skipped", trackerTransport: "skipped", release: "skipped", application: "skipped" };
  environment.GATE = "check"; environment.RESULTS = JSON.stringify(skipped); environment.PR_REUSE = chosen.reuse;
  const passed = await cli("gate", environment, directory); assert.equal(passed.status, 0, passed.stderr); assert.match(passed.stdout, /Reused fresh verification.*\/runs\/20\/attempts\/1/);
  const mixed = await cli("gate", { ...environment, RESULTS: JSON.stringify({ ...skipped, application: "failure" }) }, directory); assert.equal(mixed.status, 1);
  value.liveTarget = "f".repeat(40);
  const changed = await selection(); assert.equal(changed.application, "true"); assert.equal(changed.reuse, "");
  const refused = await cli("gate", environment, directory); assert.equal(refused.status, 1);
  delete value.liveTarget;
  value.currentFull = true;
  assert.equal((await selection()).reuse, "", "a newly requested full override invalidates the older scope selection");
  value.currentFull = false;
  value.currentDraft = true;
  assert.equal((await selection()).reuse, "", "readiness applicability must still be current");
  value.currentDraft = false;
  value.liveHead = "f".repeat(40);
  assert.equal((await selection()).application, "true"); delete value.liveHead;
  value.httpFailure = 403; assert.equal((await selection()).reuse, ""); delete value.httpFailure;
  const chain = await cli("record", environment, directory); assert.equal(chain.status, 1);
});
