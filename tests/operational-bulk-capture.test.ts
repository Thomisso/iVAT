import { expect, it } from "vitest";
import { validateCaptureContext, createPostgresFrameReader } from "./support/operational-bulk-capture";

it("accepts only the provisioned worktree or explicit isolated Actions checkout and strips private context", () => {
  const base = {
    linked: true, root: "/tmp/own", workspace: "/tmp/own", environment: {},
    config: 'project_id = "ivat-wt80"\n[api]\nport = 62321\n[db]\nport = 62322',
    provided: { supabaseUrl: "http://127.0.0.1:62321", databaseUrl: "postgresql://private_user:private_password@127.0.0.1:62322/postgres" },
  };
  expect(validateCaptureContext(base)).toMatchObject({ container: "supabase_db_ivat-wt80", databasePort: "62322" });
  expect(() => validateCaptureContext({ ...base, linked: false })).toThrow("capture context unavailable");
  expect(() => validateCaptureContext({ ...base, provided: { ...base.provided, databaseUrl: "postgresql://private_password@remote.example:62322/postgres" } })).toThrow("capture context unavailable");
  expect(() => validateCaptureContext({ ...base, provided: { ...base.provided, supabaseUrl: "http://127.0.0.1:54321" } })).toThrow("capture context unavailable");
  const ci = { ...base, linked: false, config: 'project_id = "ivat"\n[api]\nport = 54321\n[db]\nport = 54322', provided: { supabaseUrl: "http://127.0.0.1:54321", databaseUrl: "postgresql://private_password@127.0.0.1:54322/postgres" }, environment: { CI: "true", GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "123", GITHUB_JOB: "full" } };
  expect(validateCaptureContext(ci).container).toBe("supabase_db_ivat");
  expect(() => validateCaptureContext({ ...ci, workspace: "/tmp/foreign" })).toThrow("capture context unavailable");
});

it("retains only the first timeout's safe SQL and PLpgSQL frames across chunks without raw statements or IDs", () => {
  const frames: unknown[] = [];
  const reader = createPostgresFrameReader((frame) => frames.push(frame));
  const trace = '2026-11-13 19:30:00 UTC [456] authenticator@postgres ERROR:  57014: canceling statement due to statement timeout\n'
    + '2026-11-13 19:30:00 UTC [456] authenticator@postgres CONTEXT:  PL/pgSQL function private.flush_alerts(uuid) line 12 at SQL statement\n'
    + 'SQL function "public.root_exists" statement 1\n'
    + 'SQL function "private.scoped_root" during inlining\n'
    + '2026-11-13 19:30:00 UTC [456] authenticator@postgres STATEMENT: select private_secret_canary(\'private_document_canary\')\n'
    + '2026-11-13 19:30:01 UTC [456] authenticator@postgres ERROR: canceling statement due to statement timeout\n'
    + '2026-11-13 19:30:01 UTC [456] authenticator@postgres CONTEXT: PL/pgSQL function private.secondary(uuid) line 3 at SQL statement\n';
  for (let i = 0; i < trace.length; i += 3) reader.accept(trace.slice(i, i + 3));
  reader.finish();
  expect(frames).toEqual([
    { sqlState: "57014" },
    { schema: "private", function: "flush_alerts", line: 12 },
    { schema: "public", function: "root_exists", line: null },
    { schema: "private", function: "scoped_root", line: null },
  ]);
  expect(JSON.stringify(frames)).not.toMatch(/private_(?:secret|document)_canary|456|789|authenticator|uuid|select/);
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, vi } from "vitest";
import OperationalBulkCapture from "./support/operational-bulk-capture";
import { operationalCaptureFixture } from "./support/operational-bulk-capture-fixture";
const captures: ReturnType<typeof operationalCaptureFixture>[] = [];
afterEach(async () => { for (const fixture of captures.splice(0)) { await fixture.reporter.end("run_finished"); fixture.remove(); } vi.useRealTimers(); });
const capture = () => { const fixture = operationalCaptureFixture(); captures.push(fixture); return fixture; };

it("scopes Docker and PG capture from case-ready through afterEach result and persists only allowlisted evidence", async () => {
  vi.useFakeTimers();
  const fixture = capture();
  await fixture.reporter.begin(fixture.event);
  fixture.serverLog('2026-11-13 19:30:00 UTC [123456] postgres@postgres ERROR: canceling statement due to statement timeout\n2026-11-13 19:30:00 UTC [123456] postgres@postgres CONTEXT: PL/pgSQL function private.flush_alerts(uuid) line 7 at SQL statement\n');
  await vi.advanceTimersByTimeAsync(100);
  fixture.logs.push({ content: 'Supabase request failure diagnostics (last 32 operations; headersMs): ' + JSON.stringify({ firstFailure: { phase: "bulk_split", operation: "/rest/v1/rpc/record_split", sqlState: "57014", status: 500, headersMs: 8001, body: "private_body_canary" }, observations: [], stageFailures: [{ phase: "after_each", sqlState: "40P01", details: "private_detail_canary" }], phases: [{ phase: "finally_manual", elapsedMs: 8003 }], token: "private_token_canary" }) });
  fixture.reporter.recordRequestReport(JSON.parse(fixture.logs[0].content.slice(fixture.logs[0].content.indexOf("{"))));
  await fixture.reporter.end();
  const requests = JSON.parse(fixture.output("request.jsonl"));
  expect(requests.firstFailure).toEqual({ phase: "bulk_split", operation: "/rest/v1/rpc/record_split", sqlState: "57014", status: 500, elapsedMs: 8001 });
  expect(requests.stageFailures).toEqual([{ phase: "after_each", operation: null, sqlState: "40P01", status: null, elapsedMs: null }]);
  expect(requests.phases).toEqual([{ phase: "finally_manual", elapsedMs: 8003 }]);
  expect(JSON.parse(fixture.output("waits.jsonl"))).toEqual({ elapsedMs: expect.any(Number), waits: [{ waitType: "Lock", blockerCount: 2 }] });
  const packet = fixture.output("request.jsonl") + fixture.output("postgres.jsonl") + fixture.output("waits.jsonl");
  expect(packet).not.toMatch(/private_\w+_canary|123456|postgres@postgres|uuid|\bquery\b|\bpid\b/);
  expect(JSON.parse(fixture.output("capture.jsonl"))).toMatchObject({ reason: "target_finished", requestCaptured: true, logUnavailable: false, sampleUnavailable: false });
  const calls = [...fixture.calls];
  await vi.advanceTimersByTimeAsync(1000);
  fixture.serverLog('2026-11-13 19:30:00 UTC [123456] postgres@postgres CONTEXT: PL/pgSQL function private.late(uuid) line 8 at SQL statement\n');
  expect(fixture.calls).toEqual(calls);
  expect(fixture.output("postgres.jsonl")).not.toContain("late");
  for (const file of ["capture.jsonl", "request.jsonl", "postgres.jsonl", "waits.jsonl"]) expect(fs.statSync(path.join(fixture.root, "test-results/operational-bulk-capture", file)).mode & 0o777).toBe(0o600);
});

it("never opens Docker or PG for an unrelated case or without explicit opt-in", async () => {
  const fixture = capture();
  await fixture.reporter.begin({ ...fixture.event, name: "another case" });
  const disabled = new OperationalBulkCapture(fixture.io, {});
  await disabled.begin(fixture.event);
  expect(fixture.calls).toEqual([]);
});

it("caps an unfinished case at 120 seconds without overlapping samples or writing late rows", async () => {
  vi.useFakeTimers();
  const fixture = capture(); const release = fixture.blockSample();
  await fixture.reporter.begin(fixture.event);
  await vi.advanceTimersByTimeAsync(120000);
  expect(fixture.calls.filter(call => call === "pg_sample")).toHaveLength(1);
  expect(fixture.calls).not.toContain("docker_logs_snapshot");
  release(); await fixture.reporter.end("run_finished");
  expect(fixture.output("waits.jsonl")).toBe("");
  expect(JSON.parse(fixture.output("capture.jsonl"))).toMatchObject({ reason: "120s_cap" });
  expect(fixture.calls.filter(call => call === "pg_close")).toHaveLength(1);
});

it("closes resources on interrupted runner exit and leaves collection failures diagnostic only", async () => {
  const fixture = capture(); await fixture.reporter.begin(fixture.event);
  await fixture.reporter.end("runner_exit");
  expect(JSON.parse(fixture.output("capture.jsonl"))).toMatchObject({ reason: "runner_exit" });
  const failed = capture(); failed.failConnection();
  await expect(failed.reporter.begin(failed.event)).resolves.toBeUndefined();
  expect(JSON.parse(failed.output("capture.jsonl"))).toMatchObject({ reason: "capture_unavailable", sampleUnavailable: true });
  expect(failed.output("capture.jsonl")).not.toContain("private_connect_canary");
});

it("discards oversized raw log lines and never invents absent SQLSTATE or unsupported function schemas", () => {
  const frames: unknown[] = []; const reader = createPostgresFrameReader(frame => frames.push(frame));
  reader.accept('2026-11-13 19:30:00 UTC [5] postgres@postgres ERROR: canceling statement due to statement timeout\n');
  reader.accept('private_raw_canary'.repeat(5000)); reader.accept('\n');
  reader.accept('2026-11-13 19:30:00 UTC [5] postgres@postgres CONTEXT: PL/pgSQL function foreign.private_raw_canary(uuid) line 9 at SQL statement\n');
  reader.finish(); expect(frames).toEqual([{ sqlState: null }]);
});

it("rejects ordinary main-checkout context before opening Docker or PG", async () => {
  const fixture = capture();
  fixture.io.context = () => ({ isLinkedWorktree: false, generatedWorkdir: fixture.root });
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  const reporter = new OperationalBulkCapture(fixture.io, { IVAT_OPERATIONAL_BULK_CAPTURE: "1" });
  await reporter.begin(fixture.event);
  await reporter.end("run_finished");
  expect(fixture.calls).toEqual([]);
  expect(output).toHaveBeenCalledWith("Operational bulk capture unavailable: context validation failed");
  output.mockRestore();
});

it("cannot resurrect capture after stop while Docker inspection is pending", async () => {
  const fixture = capture(); const release = fixture.blockInspect();
  const start = fixture.reporter.begin(fixture.event);
  const stop = fixture.reporter.end("runner_exit");
  release(); await Promise.all([start, stop]);
  expect(fixture.calls).toEqual(["git_context", "docker_inspect"]);
});

it("owns and closes a late PG acquisition once when the startup cap fires", async () => {
  vi.useFakeTimers();
  const fixture = capture(); const release = fixture.blockConnect();
  const start = fixture.reporter.begin(fixture.event);
  await vi.advanceTimersByTimeAsync(120000);
  release(); await start; await fixture.reporter.end("run_finished");
  expect(fixture.calls.filter(call => call === "pg_close")).toHaveLength(1);
  expect(fixture.calls).not.toContain("pg_sample");
  expect(fixture.calls).not.toContain("docker_logs_snapshot");
  expect(JSON.parse(fixture.output("capture.jsonl"))).toMatchObject({ reason: "120s_cap", armed: false });
});

it("snapshots the original worker interval rather than the later inspection completion time", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-13T20:00:00Z"));
  const fixture = capture(); const release = fixture.blockInspect();
  const start = fixture.reporter.begin(fixture.event);
  await vi.advanceTimersByTimeAsync(500); release(); await start;
  await fixture.reporter.end();
  expect(fixture.windows).toEqual([{ since: "2026-11-13T20:00:00.000Z", until: "2026-11-13T20:00:00.500Z" }]);
});

import { afterAll, aroundEach, beforeEach, describe } from "vitest";
// Uses Vitest's real awaited hook execution, not reporter callbacks manually awaited by a fixture.
describe("actual awaited worker capture boundary", () => {
  const order: string[] = [];
  aroundEach(async run => {
    const fixture = operationalCaptureFixture();
    const inspect = fixture.io.inspect;
    fixture.io.inspect = async container => { order.push("inspect-start"); await new Promise(resolve => setTimeout(resolve, 10)); const ports = await inspect(container); order.push("inspect-finish"); return ports; };
    const connect = fixture.io.connect;
    fixture.io.connect = async url => { const client = await connect(url); order.push("pg-ready"); return { sample: client.sample, async close() { order.push("pg-close"); await client.close(); } }; };
    const logs = fixture.io.logs;
    fixture.io.logs = async (...args) => { order.push("snapshot"); await logs(...args); };
    await fixture.reporter.begin(fixture.event);
    try { await run(); }
    finally { await fixture.reporter.end(); order.push("capture-closed"); fixture.remove(); }
  });
  beforeEach(() => { order.push("beforeEach-fixture"); });
  afterEach(() => { order.push("afterEach-cleanup"); });
  it("awaits readiness before the first fixture and drains only after every hook", () => { order.push("body"); });
  afterAll(() => {
    expect(order).toEqual(["inspect-start", "inspect-finish", "pg-ready", "beforeEach-fixture", "body", "afterEach-cleanup", "pg-close", "snapshot", "capture-closed"]);
  });
});
