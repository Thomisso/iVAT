import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const scopeNames = ["common", "tracker", "trackerTransport", "release", "application", "http", "deployment"];
const documentation = file => /^(README|AGENTS|CODING_STANDARDS|GLOSSARY)\.md$/.test(file) || (file.startsWith("docs/") && file.endsWith(".md"));
const sharedInput = file => /^(package(?:-lock)?\.json|npm-shrinkwrap\.json|\.npmrc|\.nvmrc|\.node-version|\.tool-versions|tsconfig[^/]*\.json|next\.config\.[^/]+|eslint\.config\.[^/]+|vitest[^/]*\.\w+|postman\.ya?ml)$/.test(file)
  || /^supabase\/(config\.toml|migrations\/)/.test(file)
  || /^src\/lib\//.test(file) || /^deploy\/(db|gateway|proxy)\//.test(file)
  || ["src/application/client.ts", "src/proxy.ts", "worker/index.ts", "Dockerfile", "docker-compose.rosti.yml", ".dockerignore", ".env.example"].includes(file);
// Include command sources, their complete fixture/support trees, workflow
// configuration, and both sides of each controlled HTTP simulation.
const trackerInput = file => /^scripts\/(agent-tracker\.mjs|agent-tracking\/|verify-agent-tracker-transport\.mjs|tests\/(agent-tracker[^/]*\.test\.mjs|support\/agent-tracker[^/]*))$/.test(file)
  || /^scripts\/agent-tracking\//.test(file)
  || [".github/agent-tracking.json", ".github/workflows/agent-tracking.yml"].includes(file)
  || /^postman\/(mocks|simulations)\/github-agent\//.test(file);
const releaseInput = file => /^deploy\//.test(file)
  || ["Dockerfile", "docker-compose.rosti.yml", ".dockerignore", "scripts/write-release-identity.mjs", "scripts/tests/release-identity.test.mjs", ".github/workflows/prepare-release.yml", ".github/workflows/daily-backup.yml"].includes(file)
  || /^postman\/(mocks|simulations)\/(github-release|release-flow|rosti-deployment)\//.test(file);
const verificationInput = file => [".github/workflows/ci.yml", ".github/workflows/deployment-check.yml", "scripts/ci-policy.mjs", "scripts/ci-pr-evidence.mjs", "scripts/ci-timings.mjs"].includes(file)
  || /^scripts\/tests\/(ci-[^/]*|http-acceptance-policy)\.test\.mjs$/.test(file);
const applicationInput = file => /^(src|worker|tests|public|messages|emails)\//.test(file);

export function verificationPlan({ event, draft = false, fullVerification = false, files, complete = true }) {
  let conservative;
  if (event !== "pull_request") conservative = "conservative-non-pr";
  else if (fullVerification) conservative = "full-override";
  else if (typeof draft !== "boolean" || typeof fullVerification !== "boolean" || complete !== true || !Array.isArray(files) || files.some(file => typeof file !== "string" || !file.length)) conservative = "incomplete-diff";
  else if (!files.length) conservative = "empty-diff";
  else {
    const shared = files.find(sharedInput);
    const unknown = files.find(file => !documentation(file) && !applicationInput(file) && !trackerInput(file) && !releaseInput(file) && !verificationInput(file));
    if (shared) conservative = `shared-input:${shared}`;
    else if (unknown) conservative = `unknown-input:${unknown}`;
  }
  if (conservative) return {
    version: 1, profile: "full", reason: conservative,
    scopes: Object.fromEntries(scopeNames.map(scope => [scope, true])),
    reasons: Object.fromEntries(scopeNames.map(scope => [scope, conservative])),
  };
  const tracker = files.find(file => trackerInput(file) || verificationInput(file));
  const release = files.find(file => releaseInput(file) || verificationInput(file));
  const inputReason = (file, kind) => file ? `${verificationInput(file) ? "verification" : kind}-input:${file}` : `${kind}-inputs-unchanged`;
  const code = !files.every(documentation);
  const ready = code && !draft;
  const applicationReason = !code ? "application-inputs-unchanged" : ready ? "ready-application-change" : "draft-awaiting-readiness";
  return {
    version: 1,
    profile: !code ? "docs" : ready ? "full" : "draft",
    reason: !code ? "documentation-only" : ready ? "ready-change" : "draft-change",
    scopes: { common: code, tracker: Boolean(tracker), trackerTransport: Boolean(tracker), release: Boolean(release), application: ready, http: ready, deployment: ready },
    reasons: {
      common: code ? "code-checks" : "documentation-only",
      tracker: inputReason(tracker, "tracker"), trackerTransport: inputReason(tracker, "tracker"), release: inputReason(release, "release"),
      application: applicationReason, http: applicationReason,
      deployment: !code ? "documentation-only" : ready ? "conservative-ready-deployment" : "draft-awaiting-readiness",
    },
  };
}

// Compatibility for callers that display the coarse profile. Scope decisions
// belong to the complete plan, including conservative uncertainty handling.
export function classifyChanges(input) { return verificationPlan(input).profile; }

const gateScopes = {
  check: ["common", "tracker", "trackerTransport", "release", "application"],
  e2e: ["common", "http"],
  "self-hosted": ["deployment"],
};

function validPlan(plan) {
  return plan?.version === 1 && ["docs", "draft", "full"].includes(plan.profile)
    && typeof plan.reason === "string" && plan.reason.length > 0
    && plan.scopes && Object.keys(plan.scopes).length === scopeNames.length
    && scopeNames.every(scope => typeof plan.scopes[scope] === "boolean" && typeof plan.reasons?.[scope] === "string" && plan.reasons[scope].length > 0);
}

export function verificationPassed(plan, gate, results) {
  return Boolean(validPlan(plan) && Object.hasOwn(gateScopes, gate) && results?.policy === "success"
    && gateScopes[gate].every(scope => results[scope] === (plan.scopes[scope] ? "success" : "skipped")));
}

if (process.argv[2] === "gate") {
  let passed = false;
  try {
    const plan = JSON.parse(process.env.PLAN);
    const results = JSON.parse(process.env.RESULTS);
    if (process.env.PR_REUSE) {
      // A separate CLI process corroborates GitHub evidence at gate use. The
      // policy remains the single authority over scopes and actual outcomes.
      const prior = JSON.parse(execFileSync(process.execPath, [new URL("./ci-pr-evidence.mjs", import.meta.url).pathname, "validate"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
      if (!Array.isArray(prior.scopes) || !prior.scopes.length || prior.scopes.some(scope => !scopeNames.includes(scope) || !plan.scopes[scope] || (Object.hasOwn(results, scope) && results[scope] !== "skipped"))) throw new Error("Invalid reused results");
      for (const scope of prior.scopes) if (Object.hasOwn(results, scope)) results[scope] = "success";
      console.log(`Reused fresh verification from ${prior.source}`);
    }
    passed = verificationPassed(plan, process.env.GATE, results);
    if (validPlan(plan) && Object.hasOwn(gateScopes, process.env.GATE)) {
      console.log(`Verification profile: ${plan.profile} (${plan.reason}); gate: ${process.env.GATE}`);
      console.log(`policy: required; result=${results?.policy ?? "missing"}`);
      for (const scope of gateScopes[process.env.GATE]) console.log(`${scope}: ${plan.scopes[scope] ? "required" : "not applicable"} (${plan.reasons[scope]}); result=${results?.[scope] ?? "missing"}`);
    }
  } catch {
    // Malformed or incomplete result publication is failed verification.
  }
  if (!passed) {
    console.error("Required verification did not succeed", process.env.GATE);
    process.exitCode = 1;
  }
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let draft = false;
  let fullVerification = false;
  let files = [];
  let complete = false;
  try {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (process.env.GITHUB_EVENT_NAME === "pull_request") {
      const pr = event.pull_request;
      if (typeof pr.draft !== "boolean" || !Array.isArray(pr.labels) || pr.labels.some(label => typeof label?.name !== "string")) throw new Error("Incomplete PR metadata");
      draft = pr.draft;
      fullVerification = pr.labels.some(label => label.name.toLowerCase() === "ci:full");
      const { base, head } = pr;
      if (!/^[a-f0-9]{40}$/.test(base.sha) || !/^[a-f0-9]{40}$/.test(head.sha)) throw new Error("Incomplete PR revisions");
      // NUL separation keeps unusual filenames unambiguous. Read the complete
      // merge-base diff, without the changed-file API's page/size limits.
      // Expanding renames into deletion/addition retains both dependency paths.
      files = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base.sha}...${head.sha}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\0").filter(Boolean);
      complete = true;
    }
  } catch {
    // Unavailable or malformed event/revision data has uncertain impact.
  }
  const plan = verificationPlan({ event: process.env.GITHUB_EVENT_NAME, draft, fullVerification: fullVerification || process.env.CI_CANDIDATE_FULL === "true", files, complete });
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `profile=${plan.profile}\nplan=${JSON.stringify(plan)}\n${Object.entries(plan.scopes).map(([scope, required]) => `${scope}=${required}`).join("\n")}\n`);
  console.log(`Verification profile: ${plan.profile} (${plan.reason})`);
  for (const scope of scopeNames) console.log(`${scope}: ${plan.scopes[scope] ? "required" : "not applicable"} (${plan.reasons[scope]})`);
}
