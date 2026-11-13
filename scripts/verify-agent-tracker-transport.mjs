import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracker = process.argv[2] || path.join(fixtureRoot, "scripts/agent-tracker.mjs");
const simulation = path.join(fixtureRoot, "postman/simulations/github-agent/github-agent.sim.yaml");
const temporary = await mkdtemp(path.join(os.tmpdir(), "ivat-agent-http-"));
await mkdir(path.join(temporary, "gh"));
const reserve = net.createServer();
await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const proxy = spawn("postman", ["simulation", "run", simulation, "--proxy", "--proxy-port", String(port), "--no-history"], { cwd: fixtureRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let proxyLog = "";
let ca;
const ready = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Postman proxy startup timed out: ${proxyLog}`)), 15000);
  const consume = chunk => {
    proxyLog += chunk;
    const match = /NODE_EXTRA_CA_CERTS=(\S+)/.exec(proxyLog);
    if (match) { ca = match[1]; clearTimeout(timeout); resolve(); }
  };
  proxy.stdout.on("data", consume); proxy.stderr.on("data", consume);
  proxy.once("error", error => { clearTimeout(timeout); reject(error); });
  proxy.once("exit", code => { if (!ca) { clearTimeout(timeout); reject(new Error(`Postman proxy exited ${code}: ${proxyLog}`)); } });
});
const execute = (executable, args, environment, input) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { cwd: temporary, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("error", reject);
  const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${executable} timed out`)); }, 45000);
  child.once("exit", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  child.stdin.end(input);
});
try {
  await ready;
  // Postman 1.73 may generate a proxy certificate with a negative serial.
  // Go documents this parser compatibility option; it does not disable chain
  // or hostname verification. Scope it to this synthetic proxy-only environment.
  // https://go.dev/doc/godebug#go-123
  const environment = { ...process.env, GH_TOKEN: "synthetic-simulation-token", GITHUB_TOKEN: "", GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "",
    GH_HOST: "github.com", GH_REPO: "simulation-owner/agent-tracking", GH_CONFIG_DIR: path.join(temporary, "gh"), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1",
    HTTPS_PROXY: `http://127.0.0.1:${port}`, HTTP_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: "", no_proxy: "", SSL_CERT_FILE: ca, GODEBUG: "x509negativeserial=1",
  };
  const api = async (endpoint, body) => {
    const result = await execute("gh", ["api", endpoint, "--hostname", "github.com", ...(body ? ["--method", "POST", "--input", "-"] : [])], environment, body ? JSON.stringify(body) : undefined);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };
  const config = path.join(temporary, "agent-tracking.json");
  const setup = (extra = []) => execute(process.execPath, [tracker, "setup", "--repo", "simulation-owner/agent-tracking", "--owner", "simulation-owner", "--project-number", "1", "--registry-issue", "9001", "--config", config, ...extra], environment);
  const doctor = () => execute(process.execPath, [tracker, "doctor", "--config", config], environment);

  const untrustedCa = path.join(temporary, "untrusted.pem");
  await writeFile(untrustedCa, "");
  const untrusted = await execute("gh", ["api", "user", "--hostname", "github.com"], { ...environment, SSL_CERT_FILE: untrustedCa, SSL_CERT_DIR: path.join(temporary, "gh") });
  assert.notEqual(untrusted.code, 0, "the compatibility option must not bypass CA verification");
  assert.match(untrusted.stderr, /certificate|x509/i);
  assert.equal((await api("user")).login, "simulation-owner");
  let result = await setup();
  assert.equal(result.code, 0, result.stderr);
  let state = await api("__state");
  assert.equal(state.comments[9001].length, 1);
  const fieldCount = state.fields.length;
  assert.ok(fieldCount > 1, "setup creates consumed tracking fields");
  assert.ok(state.fields[0].options.some(option => option.id === "status_todo"), "existing Status option identities remain intact");
  assert.equal((await setup()).code, 0);
  state = await api("__state");
  assert.equal(state.fields.length, fieldCount);
  assert.equal(state.comments[9001].length, 1);
  assert.equal((await doctor()).code, 0);

  await api("__control", { workflows: [{ id: "PVTW_closed", name: "Item closed", enabled: true }] });
  result = await setup();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /native_workflows_enabled/);
  assert.equal((await setup(["--disable-native-workflows"])).code, 0);
  assert.equal((await api("__state")).workflows.length, 0);

  await api("__control", { failure: { match: "TrackerProject", phase: "before", mode: "json", status: 403, remaining: 1 } });
  result = await doctor();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /github_permission_denied/);

  await api("__control", { failure: { match: "TrackerProject", phase: "before", mode: "html", status: 502, remaining: 1 } });
  result = await doctor();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /github_connection_failed/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_SIMULATED_GITHUB_BODY/);

  const initialized = await execute("git", ["init", "-q"], environment);
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.equal((await execute("git", ["-c", "user.name=Tracker simulation", "-c", "user.email=tracker@example.test", "commit", "--allow-empty", "-m", "Simulation fixture"], environment)).code, 0);
  assert.equal((await execute("git", ["branch", "feature/http-fixture"], environment)).code, 0);
  const command = (name, args = []) => execute(process.execPath, [tracker, name, "--config", config, ...args], environment);
  const worker = event => execute(process.execPath, [tracker, "worker", "--config", config], { ...environment,
    GITHUB_ACTIONS: "true", GITHUB_JOB: "publish", GITHUB_ACTOR: "simulation-owner",
    GITHUB_WORKFLOW_REF: "simulation-owner/agent-tracking/.github/workflows/agent-tracking.yml@refs/heads/main", TRACKER_EVENT: event,
  });
  result = await command("start", ["--run", "http-simulation-run", "--at", "2026-11-04T12:00:00.000Z", "--wait-seconds", "0"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /publication_pending/);
  let event = (await api("__state")).dispatches.at(-1).event;
  result = await worker(event);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await command("sync", ["--wait-seconds", "0"])).code, 0);
  assert.equal((await worker(event)).code, 0, "duplicate start receipt is idempotent");

  result = await command("claim", ["--issue", "7", "--agent", "implementer-a", "--branch", "feature/http-fixture", "--result", "Synthetic implementation started", "--at", "2026-11-04T12:01:00.000Z", "--wait-seconds", "0"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /publication_pending/);
  event = (await api("__state")).dispatches.at(-1).event;
  await api("__control", { failure: { match: "TrackerSetFields", phase: "before", mode: "html", status: 502, remaining: 1 } });
  result = await worker(event);
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_SIMULATED_GITHUB_BODY/);
  const pending = JSON.parse((await command("show")).stdout);
  assert.equal(pending.remote.revision, 2);
  assert.equal(pending.remote.publishedRevision, 1, "partial projection is not acknowledged");
  assert.equal(pending.local.pending.length, 1);
  result = await worker(event);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await command("sync", ["--wait-seconds", "0"])).code, 0);
  assert.equal((await worker(event)).code, 0);
  state = await api("__state");
  assert.equal(Object.keys(state.items).length, 1);
  assert.equal(state.comments[7].length, 1);
  const published = JSON.parse((await command("show")).stdout);
  assert.equal(published.remote.publishedRevision, 2);
  assert.equal(published.local.pending.length, 0);
  assert.equal(published.remote.tickets[7].stateAt, "2026-11-04T12:01:00.000Z");
  const repairCursor = (await api("__state")).requests.length;
  result = await command("repair", ["--wait-seconds", "0"]);
  assert.equal(result.code, 1);
  event = (await api("__state")).dispatches.at(-1).event;
  result = await worker(event);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await command("sync", ["--wait-seconds", "0"])).code, 0);
  state = await api("__state");
  assert.ok(state.requests.some(request => request.operation === "TrackerItemFields"), "real gh exercised field readback");
  const repairEffects = state.requests.slice(repairCursor).filter(request => ["TrackerAddItem", "TrackerSetFields"].includes(request.operation) || request.path.endsWith("/assignees") || request.method === "POST" && request.path.endsWith("/issues/7/comments") || request.method === "PATCH" && request.path === `/repos/${state.repository}/issues/comments/${state.comments[7][0].id}`);
  assert.deepEqual(repairEffects, [], "unchanged repair acknowledges without repeated external projection writes");

  const beforeRepair = JSON.parse((await command("show")).stdout).remote;
  const originalItem = beforeRepair.tickets[7].projectItemId;
  result = await command("repair", ["--wait-seconds", "0"]);
  assert.equal(result.code, 1);
  const repairEvent = (await api("__state")).dispatches.at(-1).event;
  const missing = { type: "NOT_FOUND", path: ["node"], message: `Could not resolve to a node with the global id of '${originalItem}'.` };
  for (const [errors, expected] of [
    [[{ type: "FORBIDDEN", path: ["node"], message: "Resource not accessible by integration" }], "github_permission_denied"],
    [[missing, { type: "INTERNAL", path: ["node"], message: "Temporarily unavailable" }], "github_request_rejected"],
    [[{ ...missing, path: ["node", "fieldValues"] }], "github_request_rejected"],
  ]) {
    await api("__control", { failure: { match: "TrackerItemFields", phase: "before", mode: "graphql-response", body: { data: { node: null }, errors }, remaining: 1 } });
    result = await worker(repairEvent);
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(expected));
    assert.deepEqual(JSON.parse((await command("show")).stdout).remote, beforeRepair, "an unrelated item-read error cannot change canonical evidence or acknowledge repair");
  }
  await api("__control", { removeItem: originalItem });
  result = await worker(repairEvent);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await command("sync", ["--wait-seconds", "0"])).code, 0);
  const repaired = JSON.parse((await command("show")).stdout).remote;
  assert.equal(repaired.receipts[JSON.parse(repairEvent).id].state, "published");
  assert.equal(repaired.tickets[7].manualConflict.kind, "membership_missing");
  assert.equal(repaired.tickets[7].stateAt, beforeRepair.tickets[7].stateAt);
  assert.equal(repaired.tickets[7].status, beforeRepair.tickets[7].status);
  assert.notEqual(repaired.tickets[7].projectItemId, originalItem);
  state = await api("__state");
  assert.equal(Object.keys(state.items).length, 1);
  assert.equal(state.comments[7].length, 1);
  assert.equal(state.dispatches.at(-1).event, repairEvent, "the retry preserves the exact originally dispatched envelope");

  for (const path of ["/issues/7/sub_issues", "/issues/7/dependencies/blocked_by"]) assert.ok((await api("__state")).requests.some(request => request.method === "GET" && request.path.endsWith(path)), `real gh verified first-claim facts ${path}`);

  const headRevision = (await execute("git", ["rev-parse", "feature/http-fixture"], environment)).stdout.trim();
  const treeRevision = (await execute("git", ["show", "-s", "--format=%T", headRevision], environment)).stdout.trim();
  const actualResult = "1".repeat(40);
  const laterTarget = "2".repeat(40);
  await api("__control", { mergeFacts: { head: headRevision, result: actualResult, target: laterTarget, tree: treeRevision, at: "2026-11-05T19:09:13Z" } });
  assert.equal(Object.hasOwn(await api("repos/simulation-owner/agent-tracking/pulls/42"), "merge_commit_sha"), false);
  result = await command("final-pr", ["--issue", "7", "--pr", "42", "--result", "Actual GraphQL merged result corroborated", "--wait-seconds", "0"]);
  assert.equal(result.code, 1);
  event = (await api("__state")).dispatches.at(-1).event;
  result = await worker(event);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await command("sync", ["--wait-seconds", "0"])).code, 0);
  const bound = JSON.parse((await command("show")).stdout).remote.tickets[7];
  assert.equal(bound.final.revision, actualResult);
  assert.notEqual(bound.final.revision, headRevision);
  assert.notEqual(bound.final.revision, laterTarget);
  assert.equal(bound.status, "implementing", "a merged binding alone does not satisfy final gates");
  assert.ok((await api("__state")).requests.some(request => request.operation === "TrackerMergedPullRequest"));

  // Admission uses actual Actions metadata over the same supported gh transport.
  result = await command("repair", ["--wait-seconds", "0"]);
  assert.match(result.stderr, /publication_pending/);
  const admissionStart = await api("__state");
  const admissionHead = admissionStart.dispatches.at(-1).event;
  const admissionRun = admissionStart.dispatches.length;
  const runPath = `/repos/${admissionStart.repository}/actions/runs/${admissionRun}`;
  for (const status of ["queued", "pending", "requested", "waiting", "in_progress"]) {
    await api("__control", { workflowRun: { status } });
    result = await command(status === "queued" || status === "pending" ? "repair" : "sync", ["--wait-seconds", "0"]);
    assert.match(result.stderr, /publication_pending/);
    assert.equal((await api("__state")).dispatches.length, admissionRun, "active mapped head never creates another workflow");
  }
  const admissionPending = JSON.parse((await command("show", ["--local"])).stdout).local.pending;
  assert.equal(admissionPending.length, 3);
  assert.equal(JSON.stringify(admissionPending[0]), admissionHead);
  for (const failure of [
    { mode: "json", status: 403 },
    { mode: "html", status: 502 },
  ]) {
    await api("__control", { failure: { match: `GET ${runPath}`, phase: "before", remaining: 1, ...failure } });
    result = await command("sync", ["--wait-seconds", "0"]);
    assert.match(result.stderr, /publication_pending/);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_SIMULATED_GITHUB_BODY/);
    assert.deepEqual(JSON.parse((await command("show", ["--local"])).stdout).local.pending, admissionPending);
    assert.equal((await api("__state")).dispatches.length, admissionRun);
  }
  for (const workflowRunResponse of [null, { id: admissionRun, status: "completed" }]) {
    await api("__control", { workflowRunResponse });
    result = await command("sync", ["--wait-seconds", "0"]);
    assert.match(result.stderr, /publication_pending/);
    assert.equal((await api("__state")).dispatches.length, admissionRun);
  }
  await api("__control", { workflowRun: { status: "completed", conclusion: "success" } });
  result = await command("sync", ["--wait-seconds", "0"]);
  assert.match(result.stderr, /publication_pending/);
  state = await api("__state");
  assert.equal(state.dispatches.length, admissionRun + 1);
  assert.equal(state.dispatches.at(-1).event, admissionHead, "completion retries the identical saved envelope");
  assert.deepEqual(JSON.parse((await command("show", ["--local"])).stdout).local.pending, admissionPending);
  assert.equal((await worker(admissionHead)).code, 0);
  // Receipt authority survives Actions permission loss and advances FIFO.
  await api("__control", { workflowRun: { status: "queued" }, failure: { match: `GET /repos/${state.repository}/actions/runs/${state.dispatches.length}`, phase: "before", mode: "json", status: 403, remaining: 1 } });
  result = await command("sync", ["--wait-seconds", "0"]);
  assert.match(result.stderr, /publication_pending/);
  state = await api("__state");
  assert.equal(state.failure.remaining, 1);
  assert.equal(state.dispatches.at(-1).event, JSON.stringify(admissionPending[1]));
  await api("__control", { failure: null });
  for (const pendingEvent of admissionPending.slice(1)) {
    assert.equal((await worker(JSON.stringify(pendingEvent))).code, 0);
    result = await command("sync", ["--wait-seconds", "0"]);
  }
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse((await command("show", ["--local"])).stdout).local.pending.length, 0);
  assert.ok((await api("__state")).requests.some(request => request.method === "GET" && request.path === runPath), "real gh exercised Actions run readback");

  // An ambiguous dispatch response without a saved mapping keeps its old recovery.
  const beforeLostDispatch = (await api("__state")).dispatches.length;
  await api("__control", { failure: { match: `POST /repos/${state.repository}/actions/workflows/agent-tracking.yml/dispatches`, phase: "after", mode: "html", status: 502, remaining: 1 } });
  result = await command("repair", ["--wait-seconds", "0"]);
  assert.match(result.stderr, /publication_pending/);
  const lostDispatch = (await api("__state")).dispatches.at(-1).event;
  assert.equal(JSON.parse((await command("show", ["--local"])).stdout).local.dispatches[JSON.parse(lostDispatch).id], undefined);
  result = await command("sync", ["--wait-seconds", "0"]);
  assert.match(result.stderr, /publication_pending/);
  state = await api("__state");
  assert.equal(state.dispatches.length, beforeLostDispatch + 2);
  assert.equal(state.dispatches.at(-1).event, lostDispatch);
  assert.equal((await worker(lostDispatch)).code, 0);
  assert.equal((await command("sync", ["--wait-seconds", "0"])).code, 0);

  await api("__control", { reset: true, failure: { match: "TrackerCreateField", phase: "before", mode: "graphql-validation", remaining: 1 } });
  result = await setup();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /github_request_rejected/);

  await api("__control", { reset: true, failure: { match: "POST /repos/simulation-owner/agent-tracking/issues/9001/comments", phase: "after", mode: "html", status: 502, remaining: 1 } });
  result = await setup();
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_SIMULATED_GITHUB_BODY/);
  assert.equal((await api("__state")).comments[9001].length, 1, "remote create happened before response failure");
  result = await setup();
  assert.equal(result.code, 0, result.stderr);
  state = await api("__state");
  assert.equal(state.comments[9001].length, 1, "retry discovers the existing registry comment");
  assert.ok(state.requests.some(request => request.operation === "TrackerCreateField"));
  assert.ok(state.requests.some(request => request.path.endsWith("/issues/9001/comments") && request.method === "POST"));
  assert.match(proxyLog, /api\.github\.com/);
  console.log(JSON.stringify({ ok: true, transport: "real gh and tracker CLI/worker over Postman HTTPS proxy", cases: ["untrusted CA refusal", "setup", "repeat setup", "doctor", "native workflow refusal and explicit removal", "permission refusal", "HTML failure sanitation", "durable dispatch and real worker", "partial projection retry", "duplicate worker receipt", "unchanged repair skips projection mutations", "deleted node repair preserves envelope", "permission/mixed/wrong-path item errors refuse repair", "GraphQL rejection classification", "create persisted before failed response", "retry without duplicate registry", "GraphQL merged result after REST field removal", "mapped active dispatch admission", "run metadata failure preserves FIFO", "completed run retries exact envelope", "receipt outranks Actions permission loss", "lost dispatch response keeps same-event recovery"], fields: state.fields.length, requests: state.requests.length }));
} finally {
  try { process.kill(-proxy.pid, "SIGINT"); } catch { /* Already stopped. */ }
  await new Promise(resolve => { const timeout = setTimeout(resolve, 3000); proxy.once("exit", () => { clearTimeout(timeout); resolve(); }); });
  try { process.kill(-proxy.pid, "SIGKILL"); } catch { /* Process group is gone. */ }
  await rm(temporary, { recursive: true, force: true });
}
