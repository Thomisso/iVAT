// Schema-derived from GitHub's List workflow runs for a workflow contract.
// Owner discovery was unavailable: local Postman CLI is signed out.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("http");
let behavior = "success";
let revision = "";
let candidateState = null;
const polls = {};
const json = (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
http.createServer((request, response) => {
  const url = new URL(request.url, "http://local.test");
  if (request.method === "POST" && url.pathname === "/__control") {
    behavior = request.body.behavior || "success";
    revision = request.body.revision || "";
    candidateState = request.body.candidateState || null;
    for (const key of Object.keys(polls)) delete polls[key];
    return json(response, 200, { ready: true });
  }
  if (candidateState) {
    if (behavior === "forbidden") return json(response, 403, { message: "Forbidden" });
    if (behavior === "html") { response.writeHead(502, { "content-type": "text/html" }); return response.end("PRIVATE_GITHUB_RESPONSE"); }
    if (behavior === "malformed") return response.end("PRIVATE_INVALID_JSON");
    const { candidate, evidence, archiveBase64, downloadUrl } = candidateState;
    if (request.method === "POST" && url.pathname.endsWith("/workflows/release-verification.yml/dispatches")) {
      if (request.body.ref !== candidate.tag || request.body.inputs?.candidate !== JSON.stringify(candidate) || request.body.inputs?.requestId !== candidate.requestId) return json(response, 422, { message: "Invalid candidate request" });
      return json(response, 200, { workflow_run_id: 20, run_url: "https://api.github.com/repos/thomisso/ivat/actions/runs/20", html_url: "https://github.com/thomisso/ivat/actions/runs/20" });
    }
    if (request.method !== "GET") return json(response, 501, { message: "Endpoint not modelled" });
    if (url.pathname === "/candidate-archive") { response.writeHead(200); return response.end(Buffer.from(behavior === "tampered" ? "dGFtcGVyZWQ=" : archiveBase64, "base64")); }
    if (!request.headers.authorization) return json(response, 401, { message: "Unauthorized" });
    if (decodeURIComponent(url.pathname).endsWith("/commits/heads/main")) return json(response, 200, { sha: behavior === "wrong-target" ? "f".repeat(40) : candidate.targetRevision });
    if (decodeURIComponent(url.pathname).endsWith(`/commits/tags/${candidate.tag}`)) return json(response, 422, { message: `No commit found for SHA: tags/${candidate.tag}` });
    const sourceRef = candidate.purpose === "release" ? candidate.sourceRef : candidate.revision;
    // Get a commit peels annotated tags when the full refs/tags namespace is used.
    if (decodeURIComponent(url.pathname).endsWith(`/commits/${sourceRef}`)) return json(response, 200, { sha: candidate.revision, commit: { tree: { sha: candidate.sourceTree } } });
    if (url.pathname.endsWith("/workflows/release-verification.yml/runs")) return json(response, 200, { total_count: 1, workflow_runs: [evidence.run] });
    if (/\/runs\/20(?:\/attempts\/1)?$/.test(url.pathname)) return json(response, 200, evidence.run);
    if (url.pathname.endsWith("/runs/20/attempts/1/jobs")) return json(response, 200, { total_count: evidence.jobs.length, jobs: evidence.jobs });
    if (url.pathname.endsWith("/runs/20/artifacts")) return json(response, 200, { total_count: 1, artifacts: [evidence.artifact] });
    if (url.pathname.endsWith("/artifacts/30/zip")) { response.writeHead(302, { Location: downloadUrl }); return response.end(); }
    return json(response, 501, { message: "Endpoint not modelled" });
  }
  const workflow = /^\/repos\/thomisso\/ivat\/actions\/workflows\/(ci\.yml|deployment-check\.yml)\/runs$/.exec(url.pathname)?.[1];
  if (request.method !== "GET" || !workflow) return json(response, 501, { message: "Endpoint not modelled" });
  if (!request.headers.authorization) return json(response, 401, { message: "Unauthorized" });
  if (behavior === "forbidden") return json(response, 403, { message: "Forbidden" });
  if (behavior === "html") { response.writeHead(502, { "content-type": "text/html" }); return response.end("PRIVATE_GITHUB_RESPONSE"); }
  if (behavior === "malformed") return response.end("PRIVATE_INVALID_JSON");
  if (behavior === "timeout") return setTimeout(() => json(response, 200, { total_count: 0, workflow_runs: [] }), 2000);
  if (url.searchParams.get("head_sha") !== revision || url.searchParams.get("branch") !== "main" || url.searchParams.get("event") !== "push" || url.searchParams.get("per_page") !== "100") return json(response, 200, { total_count: 0, workflow_runs: [] });
  polls[workflow] = (polls[workflow] || 0) + 1;
  const run = { id: 10, head_sha: behavior === "wrong-sha" ? "f".repeat(40) : revision, head_branch: "main", event: behavior === "pr-only" ? "pull_request" : "push", status: behavior === "pending" || (behavior === "eventually-success" && polls[workflow] === 1) ? "in_progress" : "completed", conclusion: "success" };
  const runs = behavior === "missing" ? [] : behavior === "failed" ? [run, { ...run, id: 11, status: "completed", conclusion: "failure" }] : [run];
  return json(response, 200, { total_count: runs.length, workflow_runs: runs });
}).listen(process.env.PORT || 4956);
