// GitHub storage/transport subset; never simulates the tracker reducer or worker.
// Owner-published mock discovery was skipped: the local Postman CLI is signed out.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("http");
const KEY = "github-agent:snapshot";
const seed = () => ({ repository: "simulation-owner/agent-tracking", nextComment: 1000,
  comments: {}, dispatches: [], requests: [], failure: null, items: {}, nextItem: 1, workflows: [], assignees: {},
  fields: [{ id: "PVTSSF_status", name: "Status", dataType: "SINGLE_SELECT", options: [
    { id: "status_todo", name: "Todo", color: "GRAY", description: "" },
    { id: "status_working", name: "In Progress", color: "YELLOW", description: "" },
    { id: "status_done", name: "Done", color: "GREEN", description: "" },
  ] }],
});
const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json", "x-oauth-scopes": "repo,project,workflow" });
  response.end(body === undefined ? undefined : JSON.stringify(body));
};
const project = () => ({ id: "PVT_simulated", number: 1, title: "Agent tracking simulation", url: "https://github.com/users/simulation-owner/projects/1" });
const issue = (number, repository) => ({ id: 10000 + number, node_id: `I_simulated_${number}`, number,
  title: number === 9001 ? "Agent tracking registry" : `Simulation issue ${number}`, state: "open",
  html_url: `https://github.com/${repository}/issues/${number}`, url: `https://api.github.com/repos/${repository}/issues/${number}`,
  body: "Synthetic transport fixture; no private Documents.", labels: [{ name: "ready-for-agent" }], assignees: [],
});
const fail = (response, failure) => {
  if (failure.mode === "graphql-response") return json(response, 200, failure.body);
  if (failure.mode === "graphql-validation") return json(response, 200, { errors: [{ type: "UNPROCESSABLE", message: "Name cannot have a reserved value" }] });
  if (failure.mode === "disconnect") return response.destroy();
  if (failure.mode === "html") {
    response.writeHead(failure.status || 502, { "content-type": "text/html" });
    return response.end("PRIVATE_SIMULATED_GITHUB_BODY");
  }
  return json(response, failure.status || 503, { message: "Synthetic GitHub transport failure" });
};
http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://github-agent.local");
  let state = await pm.state.get(KEY) || seed();
  if (request.method === "POST" && url.pathname === "/__control") {
    if (request.body.reset) state = seed();
    if (request.body.repository) state.repository = request.body.repository;
    if (request.body.failure !== undefined) state.failure = request.body.failure;
    if (request.body.workflowRun !== undefined) { state.workflowRun = request.body.workflowRun; delete state.workflowRunResponse; }
    if (Object.hasOwn(request.body, "workflowRunResponse")) state.workflowRunResponse = request.body.workflowRunResponse;
    if (request.body.removeItem) for (const [key, item] of Object.entries(state.items)) if (item.id === request.body.removeItem) delete state.items[key];
    if (request.body.workflows !== undefined) state.workflows = request.body.workflows;
    if (request.body.mergeFacts !== undefined) state.mergeFacts = request.body.mergeFacts;
    await pm.state.set(KEY, state);
    return json(response, 200, { ready: true });
  }
  if (request.method === "GET" && url.pathname === "/__state") return json(response, 200, state);
  if (!request.headers.authorization) return json(response, 401, { message: "Requires authentication" });
  const query = request.body?.query || "";
  const operation = request.body?.operationName || /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] || "";
  const call = `${request.method} ${url.pathname}`;
  state.requests.push({ method: request.method, path: url.pathname, operation });
  const failure = state.failure && (!state.failure.match || [call, operation].includes(state.failure.match)) && state.failure.remaining > 0 ? { ...state.failure } : null;
  if (failure) state.failure.remaining -= 1;
  await pm.state.set(KEY, state);
  if (failure && failure.phase !== "after") return fail(response, failure);
  const finish = async (status, body) => { await pm.state.set(KEY, state); return failure ? fail(response, failure) : json(response, status, body); };
  if (call === "GET /user") return finish(200, { login: "simulation-owner", id: 1, node_id: "U_simulation_owner" });
  const base = `/repos/${state.repository}`;
  if (call === `GET ${base}`) return finish(200, { id: 1, node_id: "R_simulated", full_name: state.repository,
    name: state.repository.split("/")[1], owner: { login: state.repository.split("/")[0], type: "User" }, default_branch: "main", permissions: { push: true } });
  if (call === `GET ${base}/pulls/42` && state.mergeFacts) return finish(200, { node_id: "PR_simulated_42", number: 42, html_url: `https://github.com/${state.repository}/pull/42`, state: "closed", draft: false, merged: true, merged_at: state.mergeFacts.at, head: { ref: "feature/http-fixture", sha: state.mergeFacts.head, repo: { full_name: state.repository } }, base: { ref: "main", repo: { full_name: state.repository } } });
  const commit = new RegExp(`^${base}/commits/(.+)$`).exec(url.pathname);
  if (commit && request.method === "GET" && state.mergeFacts) {
    const ref = decodeURIComponent(commit[1]);
    const sha = ref === "main" ? state.mergeFacts.target : ref;
    if ([state.mergeFacts.head, state.mergeFacts.result, state.mergeFacts.target].includes(sha)) return finish(200, { sha, commit: { tree: { sha: state.mergeFacts.tree } } });
  }
  const comments = new RegExp(`^${base}/issues/(\\d+)/comments$`).exec(url.pathname);
  if (comments && request.method === "GET") return finish(200, state.comments[comments[1]] || []);
  if (comments && request.method === "POST") {
    if (typeof request.body?.body !== "string") return finish(422, { message: "body is required" });
    const id = state.nextComment++;
    const record = { id, node_id: `IC_simulated_${id}`, body: request.body.body,
      html_url: `https://github.com/${state.repository}/issues/${comments[1]}#issuecomment-${id}`, user: { login: "simulation-owner" } };
    state.comments[comments[1]] ||= []; state.comments[comments[1]].push(record);
    return finish(201, record);
  }
  const comment = new RegExp(`^${base}/issues/comments/(\\d+)$`).exec(url.pathname);
  if (comment && ["GET", "PATCH"].includes(request.method)) {
    const record = Object.values(state.comments).flat().find(item => item.id === Number(comment[1]));
    if (!record) return finish(404, { message: "Not Found" });
    if (request.method === "PATCH") record.body = request.body.body;
    return finish(200, record);
  }
  const implementationFacts = new RegExp(`^${base}/issues/(\\d+)/(?:sub_issues|dependencies/blocked_by)$`).exec(url.pathname);
  if (implementationFacts && request.method === "GET") return finish(200, []);
  const parent = new RegExp(`^${base}/issues/(\\d+)/parent$`).exec(url.pathname);
  if (parent && request.method === "GET") return Number(parent[1]) === 7 ? finish(200, issue(8, state.repository)) : finish(404, { message: "Not Found" });
  const selected = new RegExp(`^${base}/issues/(\\d+)$`).exec(url.pathname);
  if (selected && request.method === "GET") return finish(200, { ...issue(Number(selected[1]), state.repository), assignees: (state.assignees[selected[1]] || []).map(login => ({ login })) });
  const assignees = new RegExp(`^${base}/issues/(\\d+)/assignees$`).exec(url.pathname);
  if (assignees && request.method === "POST") {
    state.assignees[assignees[1]] = [...new Set([...(state.assignees[assignees[1]] || []), ...request.body.assignees])];
    return finish(201, { ...issue(Number(assignees[1]), state.repository), assignees: state.assignees[assignees[1]].map(login => ({ login })) });
  }
  const run = new RegExp(`^${base}/actions/runs/(\\d+)$`).exec(url.pathname);
  if (run && request.method === "GET") {
    const id = Number(run[1]);
    if (!state.dispatches[id - 1]) return finish(404, { message: "Not Found" });
    return finish(200, Object.hasOwn(state, "workflowRunResponse") ? state.workflowRunResponse : { id, repository: { full_name: state.repository }, path: ".github/workflows/agent-tracking.yml", event: "workflow_dispatch", status: "queued", ...state.workflowRun });
  }
  if (call === `POST ${base}/actions/workflows/agent-tracking.yml/dispatches`) {
    if (typeof request.body?.ref !== "string" || typeof request.body?.inputs?.event !== "string") return finish(422, { message: "Workflow ref and string event input are required" });
    state.dispatches.push({ ref: request.body.ref, event: request.body.inputs.event });
    const id = state.dispatches.length;
    return finish(200, { workflow_run_id: id, run_url: `https://api.github.com/repos/${state.repository}/actions/runs/${id}`, html_url: `https://github.com/${state.repository}/actions/runs/${id}` });
  }
  if (call === "POST /graphql") {
    const v = request.body.variables?.input || request.body.variables || {};
    if (operation === "TrackerMergedPullRequest" && state.mergeFacts) return finish(200, { data: { repository: { nameWithOwner: state.repository, pullRequest: { id: "PR_simulated_42", number: 42, repository: { nameWithOwner: state.repository }, headRefOid: state.mergeFacts.head, headRefName: "feature/http-fixture", baseRefName: "main", state: "MERGED", merged: true, mergedAt: state.mergeFacts.at, mergeCommit: { oid: state.mergeFacts.result } } } } });
    if (operation === "TrackerProject") return finish(200, { data: { user: { id: "U_simulation_owner", projectV2: project(), projectsV2: { nodes: [project()] } } } });
    if (operation === "TrackerWorkflows") return finish(200, { data: { node: { workflows: { nodes: state.workflows, pageInfo: { hasNextPage: false } } } } });
    if (operation === "TrackerDeleteWorkflow") {
      state.workflows = state.workflows.filter(workflow => workflow.id !== v.workflowId);
      return finish(200, { data: { deleteProjectV2Workflow: { deletedWorkflowId: v.workflowId } } });
    }
    if (operation === "TrackerFields") return finish(200, { data: { node: { ...project(), fields: { nodes: state.fields, pageInfo: { hasNextPage: false, endCursor: null } } } } });
    if (operation === "TrackerCreateField") {
      if (v.name === "Reviewer") return finish(200, { errors: [{ type: "UNPROCESSABLE", message: "Name cannot have a reserved value" }] });
      const field = { id: `PVTF_${state.fields.length + 1}`, name: v.name, dataType: v.dataType || v.type,
        options: (v.singleSelectOptions || v.options || []).map((option, index) => ({ ...option, id: option.id || `option_${state.fields.length}_${index}` })) };
      state.fields.push(field);
      return finish(200, { data: { createProjectV2Field: { projectV2Field: field } } });
    }
    if (operation === "TrackerUpdateField") {
      const field = state.fields.find(item => item.id === (v.fieldId || v.id));
      if (!field) return finish(200, { errors: [{ type: "NOT_FOUND", message: "Could not resolve field" }] });
      field.options = (v.singleSelectOptions || v.options || []).map((option, index) => ({ ...option, id: option.id || `option_${field.id}_${index}` }));
      return finish(200, { data: { updateProjectV2Field: { projectV2Field: field } } });
    }
    if (operation === "TrackerAddItem") {
      const content = v.contentId || v.content;
      state.items[content] ||= { id: `PVTI_${state.nextItem++}`, content: { id: content }, fields: {} };
      return finish(200, { data: { addProjectV2ItemById: { item: state.items[content] } } });
    }
    if (operation === "TrackerItemFields") {
      const item = Object.values(state.items).find(item => item.id === v.id);
      if (!item) return finish(200, { data: { node: null }, errors: [{ type: "NOT_FOUND", path: ["node"], message: `Could not resolve to a node with the global id of '${v.id}'.` }] });
      const nodes = Object.entries(item.fields).map(([id, value]) => ({ field: { id }, ...(value.singleSelectOptionId ? { optionId: value.singleSelectOptionId } : { text: value.text }) }));
      return finish(200, { data: { node: { fieldValues: { nodes, pageInfo: { hasNextPage: false } } } } });
    }
    if (operation === "TrackerSetFields") {
      const data = {};
      for (const [key, input] of Object.entries(request.body.variables)) {
        const item = Object.values(state.items).find(value => value.id === input.itemId);
        const field = state.fields.find(value => value.id === input.fieldId);
        if (!item || !field) return finish(200, { errors: [{ type: "NOT_FOUND", message: "Could not resolve item or field" }] });
        if (input.value) {
          if (field.dataType === "SINGLE_SELECT" && !field.options.some(option => option.id === input.value.singleSelectOptionId)) return finish(200, { errors: [{ type: "UNPROCESSABLE", message: "Invalid single-select option" }] });
          if (field.dataType === "TEXT" && typeof input.value.text !== "string") return finish(200, { errors: [{ type: "UNPROCESSABLE", message: "Text value is required" }] });
          item.fields[field.id] = input.value;
        } else delete item.fields[field.id];
        data[key.replace("input", "f")] = { projectV2Item: { id: item.id } };
      }
      return finish(200, { data });
    }
  }
  return finish(501, { message: "Endpoint not modelled", method: request.method, path: url.pathname, operation });
}).listen(process.env.PORT || 4981);
