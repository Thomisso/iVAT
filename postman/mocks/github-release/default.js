// Schema-derived from GitHub's List workflow runs for a workflow contract.
// Owner discovery was unavailable: local Postman CLI is signed out.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("http");
let behavior = "success";
let revision = "";
const polls = {};
const json = (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
http.createServer((request, response) => {
  const url = new URL(request.url, "http://local.test");
  if (request.method === "POST" && url.pathname === "/__control") {
    behavior = request.body.behavior || "success";
    revision = request.body.revision || "";
    for (const key of Object.keys(polls)) delete polls[key];
    return json(response, 200, { ready: true });
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
