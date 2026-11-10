import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { verificationPassed } from "./ci-policy.mjs";

// PR event/evidence policy is separate from release-candidate evidence.
export function verificationEvent(eventName, event) {
  return !(eventName === "pull_request" && ["labeled", "unlabeled"].includes(event?.action)
    && typeof event?.label?.name === "string" && event.label.name.length > 0 && event.label.name.toLowerCase() !== "ci:full");
}

const workflows = {
  "ci.yml": { gates: ["check", "e2e"], scopes: { common: ["common"], tracker: ["tracker"], trackerTransport: ["tracker"], release: ["release"], application: ["full (1)", "full (2)", "full (3)"], http: ["acceptance"] }, policy: "CI profile" },
  "deployment-check.yml": { gates: ["self-hosted"], scopes: { deployment: ["runtime"] }, policy: "Deployment profile" },
};
const sha = value => /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
function validContext(context) {
  return context && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(context.repository)
    && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(context.headRepository)
    && Object.hasOwn(workflows, context.workflow) && [context.workflowId, context.runId, context.runAttempt, context.pr].every(positive)
    && [context.head, context.checked, context.targetSha].every(sha)
    && typeof context.target === "string" && context.target.length > 0 && /^[a-f0-9]{64}$/.test(context.policy);
}

export function recordPrEvidence({ context, plan, results, reused = false }) {
  if (!validContext(context) || reused || plan?.profile !== "full"
    || !workflows[context.workflow].gates.every(gate => verificationPassed(plan, gate, results))) throw new Error("Incomplete fresh PR verification");
  return { kind: "ivat-pr-verification-v1", fresh: true, context, plan, results };
}

export function reusablePrEvidence({ context, plan, proof, run, jobs, jobAttempt, artifact }) {
  try {
    if (!validContext(context) || proof?.kind !== "ivat-pr-verification-v1" || proof.fresh !== true || !validContext(proof.context)) return false;
    const source = proof.context;
    if (source.runId === context.runId || Object.keys(context).some(key => !["runId", "runAttempt"].includes(key) && source[key] !== context[key])) return false;
    const contract = workflows[context.workflow];
    if (proof.plan?.profile !== "full" || !contract.gates.every(gate => verificationPassed(proof.plan, gate, proof.results))) return false;
    if (!contract.gates.every(gate => verificationPassed(plan, gate, { policy: "success", ...Object.fromEntries(Object.entries(plan.scopes).map(([scope, required]) => [scope, required ? "success" : "skipped"])) }))) return false;
    if (Object.keys(contract.scopes).some(scope => plan.scopes[scope] && !proof.plan.scopes[scope])) return false;
    if (run?.id !== source.runId || run.run_attempt !== source.runAttempt || run.workflow_id !== source.workflowId || run.event !== "pull_request"
      || run.status !== "completed" || run.conclusion !== "success" || run.path?.split("@")[0] !== `.github/workflows/${context.workflow}`
      || ![context.head, context.checked].includes(run.head_sha) || run.repository?.full_name?.toLowerCase() !== context.repository
      || run.head_repository?.full_name?.toLowerCase() !== context.headRepository || !run.pull_requests?.some(pr => pr.number === context.pr)) return false;
    if (!positive(artifact?.id) || artifact.name !== `pr-verification-${source.runAttempt}` || artifact.expired !== false
      || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== run.head_sha) return false;
    if (!Array.isArray(jobs) || jobAttempt !== source.runAttempt) return false;
    const expected = new Map([[contract.policy, "success"], ...contract.gates.map(gate => [gate, "success"]), ["PR verification evidence", "success"]]);
    for (const [scope, names] of Object.entries(contract.scopes)) for (const name of names) expected.set(name, proof.plan.scopes[scope] || expected.get(name) === "success" ? "success" : "skipped");
    for (const [name, conclusion] of expected) {
      const matches = jobs.filter(job => job.name === name);
      if (matches.length !== 1 || matches[0].run_id !== source.runId
        || matches[0].head_sha !== run.head_sha || matches[0].status !== "completed" || matches[0].conclusion !== conclusion) return false;
    }
    return true;
  } catch { return false; }
}

function github({ token, apiUrl = "https://api.github.com" }) {
  if (!token) throw new Error("PR evidence access unavailable");
  return async (route, archive = false) => {
    // Only construct API routes locally. Redirected artifact downloads never
    // forward this Authorization header to the storage host (fetch semantics).
    const response = await fetch(`${apiUrl}${route}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2026-03-10" }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("PR evidence request unavailable");
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > (archive ? 262144 : 1048576)) throw new Error("PR evidence exceeds limit");
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    return archive ? data : JSON.parse(data.toString("utf8"));
  };
}

export async function findReusablePrEvidence({ context, plan, token, apiUrl, selected }) {
  try {
    if (!validContext(context)) return null;
    const get = github({ token, apiUrl });
    const root = `/repos/${context.repository}/actions`;
    const listing = await get(`${root}/workflows/${context.workflow}/runs?event=pull_request&head_sha=${context.head}&per_page=100`);
    if (!Array.isArray(listing.workflow_runs) || listing.total_count !== listing.workflow_runs.length) return null;
    const candidates = listing.workflow_runs.filter(run => run.id !== context.runId && run.workflow_id === context.workflowId
      && [context.head, context.checked].includes(run.head_sha) && run.pull_requests?.some(pr => pr.number === context.pr)).sort((a, b) => b.id - a.id);
    // A successful administrative or already-reused run publishes no fresh
    // artifact. Look past those receipts, retaining the original full proof.
    // A failed/incomplete newer run remains conservative: run fresh work.
    for (const candidate of candidates.slice(0, 10)) {
      if (candidate.status !== "completed" || candidate.conclusion !== "success") return null;
      const run = await get(`${root}/runs/${candidate.id}`);
      if (run.run_attempt !== candidate.run_attempt || run.status !== "completed" || run.conclusion !== "success") return null;
      const [jobPage, artifactPage] = await Promise.all([
        get(`${root}/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`),
        get(`${root}/runs/${run.id}/artifacts?per_page=100`),
      ]);
      if (!Array.isArray(jobPage.jobs) || jobPage.total_count !== jobPage.jobs.length
        || !Array.isArray(artifactPage.artifacts) || artifactPage.total_count !== artifactPage.artifacts.length) return null;
      const matches = artifactPage.artifacts.filter(artifact => artifact.name === `pr-verification-${run.run_attempt}`);
      if (matches.length === 0) continue;
      if (matches.length !== 1 || (selected && selected.runId !== candidate.id)) return null;
      const artifact = matches[0];
      if (artifact.expired !== false || !positive(artifact.id) || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
        || (selected && (selected.runAttempt !== run.run_attempt || selected.artifactId !== artifact.id))) return null;
      const archive = await get(`${root}/artifacts/${artifact.id}/zip`, true);
      if (`sha256:${createHash("sha256").update(archive).digest("hex")}` !== artifact.digest) return null;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-pr-proof-"));
      let proof;
      try {
        const file = path.join(directory, "proof.zip"); fs.writeFileSync(file, archive);
        const entries = execFileSync("unzip", ["-Z1", file], { encoding: "utf8", maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] }).trim();
        if (entries !== "pr-verification.json") return null;
        proof = JSON.parse(execFileSync("unzip", ["-p", file, "pr-verification.json"], { encoding: "utf8", maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] }));
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
      if (!reusablePrEvidence({ context, plan, proof, run, jobs: jobPage.jobs, jobAttempt: run.run_attempt, artifact })) return null;
      // Corroborate again after the download: reruns and cancellation
      // during lookup cannot silently preserve stale provenance.
      const after = await get(`${root}/runs/${run.id}`);
      if (after.run_attempt !== run.run_attempt || after.status !== "completed" || after.conclusion !== "success") return null;
      return { runId: run.id, runAttempt: run.run_attempt, artifactId: artifact.id };
    }
    return null;
  } catch { return null; }
}

async function currentPrContext(environment, event) {
  if (environment.GITHUB_EVENT_NAME !== "pull_request") throw new Error("PR evidence requires an eligible PR event");
  const pr = event.pull_request;
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const checked = git("rev-parse", "HEAD");
  // Read the immutable commit object's headers. History-walking formats such
  // as %P hide parents at the default depth-one checkout's shallow boundary.
  const headers = git("cat-file", "commit", checked).split("\n\n", 1)[0];
  const parents = [...headers.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(match => match[1]);
  if (checked !== environment.GITHUB_SHA || parents.length !== 2 || !parents.includes(pr.base.sha) || !parents.includes(pr.head.sha)) throw new Error("Checked PR merge differs from event inputs");
  const repository = environment.GITHUB_REPOSITORY?.toLowerCase();
  const workflow = environment.PR_WORKFLOW_FILE;
  if (!Object.hasOwn(workflows, workflow) || event.repository?.full_name?.toLowerCase() !== repository || pr.base.repo?.full_name?.toLowerCase() !== repository) throw new Error("PR repository differs");
  const policy = createHash("sha256");
  for (const file of ["scripts/ci-policy.mjs", "scripts/ci-pr-evidence.mjs", ".github/workflows/ci.yml", ".github/workflows/deployment-check.yml"]) policy.update(file).update("\0").update(fs.readFileSync(file)).update("\0");
  const get = github({ token: environment.GH_TOKEN, apiUrl: environment.GITHUB_API_URL });
  const [run, current, target] = await Promise.all([
    get(`/repos/${repository}/actions/runs/${Number(environment.GITHUB_RUN_ID)}`),
    get(`/repos/${repository}/pulls/${pr.number}`),
    get(`/repos/${repository}/branches/${encodeURIComponent(pr.base.ref)}`),
  ]);
  const context = { repository, headRepository: pr.head.repo?.full_name?.toLowerCase(), workflow, workflowId: run.workflow_id,
    runId: Number(environment.GITHUB_RUN_ID), runAttempt: Number(environment.GITHUB_RUN_ATTEMPT), pr: pr.number,
    head: pr.head.sha, checked, target: pr.base.ref, targetSha: pr.base.sha, policy: policy.digest("hex") };
  if (!validContext(context) || run.id !== context.runId || run.run_attempt !== context.runAttempt || run.event !== "pull_request"
    || run.path?.split("@")[0] !== `.github/workflows/${workflow}` || ![context.head, checked].includes(run.head_sha)
    || current.number !== pr.number || typeof current.draft !== "boolean" || current.draft !== pr.draft
    || !Array.isArray(current.labels) || !Array.isArray(pr.labels) || current.labels.some(label => typeof label?.name !== "string")
    || current.labels.some(label => label.name.toLowerCase() === "ci:full") !== pr.labels.some(label => label.name.toLowerCase() === "ci:full")
    || current.head?.sha !== context.head || current.head.repo?.full_name?.toLowerCase() !== context.headRepository
    || current.base?.sha !== context.targetSha || current.base.ref !== context.target || current.base.repo?.full_name?.toLowerCase() !== repository
    || target.commit?.sha !== context.targetSha) throw new Error("Current PR target or revision changed");
  return context;
}

async function main() {
  const environment = process.env;
  const command = process.argv[2];
  let event;
  try { event = JSON.parse(fs.readFileSync(environment.GITHUB_EVENT_PATH, "utf8")); } catch { /* Unknown event data must select fresh work. */ }
  const plan = JSON.parse(environment.PLAN);
  if (command === "select") {
    const run = environment.CI_CANDIDATE_FULL === "true" || verificationEvent(environment.GITHUB_EVENT_NAME, event);
    let reuse = null;
    if (run && environment.GITHUB_EVENT_NAME === "pull_request" && event?.action === "ready_for_review" && plan.profile === "full" && environment.CI_CANDIDATE_FULL !== "true") {
      try {
        const context = await currentPrContext(environment, event);
        reuse = await findReusablePrEvidence({ context, plan, token: environment.GH_TOKEN, apiUrl: environment.GITHUB_API_URL });
      } catch { /* Uncertain applicability reruns fresh verification. */ }
    }
    fs.appendFileSync(environment.GITHUB_OUTPUT, `run=${run}\nreuse=${reuse ? JSON.stringify(reuse) : ""}\n${Object.entries(plan.scopes).map(([scope, required]) => `${scope}=${run && !reuse && required}`).join("\n")}\n`);
    console.log(!run ? "Unrelated label: no new verification or stable-gate approval" : reuse ? `Reusing fresh PR verification: ${environment.GITHUB_REPOSITORY}/actions/runs/${reuse.runId}/attempts/${reuse.runAttempt}` : "Fresh verification required; no applicable prior evidence selected");
  } else if (command === "record") {
    if (environment.GITHUB_EVENT_NAME !== "pull_request" || environment.PR_REUSE) throw new Error("Only fresh PR verification can produce proof");
    const context = await currentPrContext(environment, event);
    const proof = recordPrEvidence({ context, plan, results: JSON.parse(environment.RESULTS) });
    fs.writeFileSync("pr-verification.json", JSON.stringify(proof) + "\n", { flag: "wx" });
  } else if (command === "validate") {
    if (event.action !== "ready_for_review" || !environment.PR_REUSE) throw new Error("No eligible PR reuse selection");
    const context = await currentPrContext(environment, event);
    const selected = JSON.parse(environment.PR_REUSE);
    const verified = await findReusablePrEvidence({ context, plan, token: environment.GH_TOKEN, apiUrl: environment.GITHUB_API_URL, selected });
    if (!verified) throw new Error("Prior PR verification is no longer applicable");
    // Repeat the live target check after source corroboration, near gate use.
    await currentPrContext(environment, event);
    console.log(JSON.stringify({ scopes: Object.keys(workflows[context.workflow].scopes).filter(scope => plan.scopes[scope]), source: `https://github.com/${context.repository}/actions/runs/${verified.runId}/attempts/${verified.runAttempt}` }));
  } else throw new Error("Expected select, record or validate");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error("PR verification evidence unavailable or no longer applicable"); process.exitCode = 1; });
