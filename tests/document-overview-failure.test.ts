import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { createClient, type Session } from "@supabase/supabase-js";
import { asUserClient } from "@/application/client";
import { withDocumentOverviewFailure } from "./support/document-overview-failure";
import { startSupabaseRequestDiagnostics } from "./support/request-failure-diagnostics";
import { listCompanyDocuments } from "@/application/documents";

const io = vi.hoisted(() => ({ root: "", calls: [] as string[], connect: undefined as Promise<void> | undefined, metadata: undefined as Promise<void> | undefined, build: undefined as Promise<void> | undefined, denyBuild: false, failPlain: false, failAnalyze: false, rejectMetadata: false, rejectQuery: "", rejectClose: false }));
vi.mock("../scripts/supabase-status.mjs", () => ({ localSupabaseContext: () => ({ isLinkedWorktree: false, generatedWorkdir: io.root }) }));
vi.mock("pg", () => ({ Client: class {
  on() { return this; }
  async connect() { io.calls.push("connect"); await io.connect; }
  async end() { io.calls.push("end"); if (io.rejectClose) throw new Error("private_close_canary"); }
  async query(sql: string) {
    io.calls.push(sql.startsWith("explain") ? sql.includes("analyze") ? "analyze" : "plain" : sql);
    if (sql === io.rejectQuery) throw new Error("private_cleanup_canary");
    if (/from pg_config\b/.test(sql)) {
      await io.build;
      if (io.denyBuild) throw { code: "42501", message: "permission denied for function pg_config", detail: "private_build_denial_canary" };
      if (!sql.includes("server_version_num")) return { rows: [{ setting: "private_build_path_canary --with-llvm" }] };
    }
    if (sql.includes("server_version_num")) {
      await io.metadata;
      if (io.rejectMetadata) throw new Error("private_metadata_canary");
      return { rows: [{ server_version_num: "170011", server_build: "PostgreSQL17.11 on x86_64-pc-linux-gnu compiled by gcc13.3", jit_available: true, provider: "llvmjit", build_config: "private_build_path_canary --with-llvm", roles: [{ role: "authenticated", settings: ["statement_timeout=8s"] }, { role: "authenticator", settings: ["statement_timeout=8s"] }], settings: [{ name: "jit", setting: "on" }, { name: "jit_above_cost", setting: "100000" }, { name: "plan_cache_mode", setting: "auto" }], tables: [{ relation: "document", rows: -1, pages: 0 }], documents: 1002, versions: 0 }] };
    }
    if (sql.includes("current_user")) return { rows: [{ role: "authenticated", rls: "on", read_only: "on" }] };
    if (sql.startsWith("explain")) {
      if (io.failPlain || (io.failAnalyze && sql.includes("analyze"))) throw { code: "57014", where: 'SQL statement "private_sql_argument_canary"\nPL/pgSQL function private.can_access_company(private_type_canary) line 42 at SQL statement\nSQL function "organization_mfa_satisfied" statement 1', detail: "private_error_body_canary" };
      return { rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Index Scan", "Actual Rows": 1000, "Actual Loops": 1, "Relation Name": "document", Filter: "private_payload_canary" }, Settings: { jit: "on", jit_above_cost: "100000", plan_cache_mode: "auto", jwt_secret: "private_setting_canary" }, "Execution Time": 123.4 }] }] };
    }
    return { rows: [] };
  }
} }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-failure-plan-")); roots.push(root); io.root = root;
  fs.mkdirSync(path.join(root, "supabase")); fs.writeFileSync(path.join(root, "supabase/config.toml"), 'project_id = "ivat"\n[api]\nport = 54321\nmax_rows = 1000\n[db]\nport = 54322\n');
  io.calls = []; io.connect = undefined; io.metadata = undefined; io.build = undefined; io.denyBuild = false; io.failPlain = false; io.failAnalyze = false; io.rejectMetadata = false; io.rejectQuery = ""; io.rejectClose = false;
  for (const [key, value] of Object.entries({ IVAT_DOCUMENT_OVERVIEW_FAILURE_CAPTURE: "1", CI: "true", GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "123", GITHUB_JOB: "full", GITHUB_WORKSPACE: root })) vi.stubEnv(key, value);
  const client = asUserClient(createClient("http://127.0.0.1:54321", "private_key_canary"));
  const claims = { role: "authenticated", sub: "11111111-1111-4111-8111-111111111111", session_id: "private_session_canary", aal: "aal1" };
  vi.spyOn(client.auth, "getSession").mockResolvedValue({ data: { session: { access_token: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`, user: { id: claims.sub } } as Session }, error: null });
  const controller = new AbortController();
  const first = { kind: "request", phase: "readback_assertions", operation: "/rest/v1/document_overview", status: 500, sqlState: "57014" };
  const failure = { ready: () => true, firstFailure: (): unknown => first, firstOverviewReadback: (): unknown => ({ ...first, ordinal: 1, completed: true }), observeOriginal: (_error: unknown) => { io.calls.push("original_observed"); }, bodyStartedAt: performance.now() - 8800, timeoutMs: 20000, signal: controller.signal };
  const context = { root, databaseUrl: "postgresql://private_password_canary@127.0.0.1:54322/postgres", supabaseUrl: "http://127.0.0.1:54321", failure };
  const original = { code: "57014", detail: "private_original_canary" };
  return { client, root, context, controller, original, async run() { let caught: unknown; try { await withDocumentOverviewFailure(client, "22222222-2222-4222-8222-222222222222", async () => { throw original; }, context); } catch (error) { caught = error; } finally { io.calls.push("public_finally"); } return caught; }, output: () => fs.readFileSync(path.join(root, "test-results/document-overview-failure.json"), "utf8") };
}

it("captures CI build/stats and one bounded authenticated plan after retaining the original public failure", async () => {
  const f = fixture(); expect(await f.run()).toBe(f.original);
  expect(io.calls[0]).toBe("original_observed"); expect(io.calls.filter(x => ["plain", "analyze"].includes(x))).toEqual(["plain", "analyze"]);
  expect(io.calls).toContain("begin read only"); expect(io.calls).toContain("set local role authenticated"); expect(io.calls.slice(-3)).toEqual(["rollback", "end", "public_finally"]);
  const raw = f.output(); const report = JSON.parse(raw);
  expect(report.metadata).toMatchObject({ serverVersionNum: 170011, architecture: "x86_64", jitAvailable: true, withLlvm: true, documents: 1002, versions: 0 });
  expect(report.analyze.plan[0]["Execution Time"]).toBe(123.4); expect(raw).not.toMatch(/private_|11111111|22222222|Filter|Output/);
  expect(report.analyze.plan[0].Settings).toEqual({ jit: true, jit_above_cost: { value: 100000, unit: null }, plan_cache_mode: "auto" });
});
it("keeps secondary diagnostic timeout frames distinct and never emits raw where/SQL", async () => {
  const f = fixture(); io.failAnalyze = true; expect(await f.run()).toBe(f.original);
  const raw = f.output(); expect(JSON.parse(raw).analyze).toMatchObject({ sqlState: "57014", source: "diagnostic_source_equivalent", frames: [{ schema: "private", function: "can_access_company", line: 42 }, { schema: null, function: "organization_mfa_satisfied", line: null }] });
  expect(raw).not.toMatch(/private_.*canary|SQL statement|private_type_canary/);
});
it("rolls back a failed plain probe and skips analysis", async () => {
  const f = fixture(); io.failPlain = true; expect(await f.run()).toBe(f.original);
  expect(io.calls).not.toContain("analyze"); expect(io.calls).toContain("rollback to savepoint overview_probe");
});
it("refuses missing ownership, unrelated first failure and foreign context before connecting", async () => {
  for (const kind of ["witness", "operation", "port"]) {
    const f = fixture(); if (kind === "witness") f.context.failure.ready = () => false;
    if (kind === "operation") f.context.failure.firstFailure = () => ({ kind: "request", phase: "readback_assertions", operation: "/rest/v1/rpc/current_business_date", status: 500, sqlState: "57014" });
    if (kind === "port") f.context.databaseUrl = "postgresql://private_password_canary@127.0.0.1:62222/postgres";
    expect(await f.run()).toBe(f.original); expect(io.calls).not.toContain("connect");
  }
});
it("reserves cleanup and skips all DB work when the actual body deadline is too close", async () => {
  const f = fixture(); f.context.failure.bodyStartedAt = performance.now() - 15500; expect(await f.run()).toBe(f.original);
  expect(io.calls).not.toContain("connect"); expect(JSON.parse(f.output())).toMatchObject({ skipped: "remaining_budget" });
});
it("does not probe a successful public read", async () => {
  const f = fixture(); const value = { unchanged: true };
  expect(await withDocumentOverviewFailure(asUserClient(createClient(f.context.supabaseUrl, "private_key_canary")), "22222222-2222-4222-8222-222222222222", async () => value, f.context)).toBe(value);
  expect(io.calls).toEqual([]);
});
it("keeps the plain plan but skips analysis when only the cleanup reserve and a shorter capture fit", async () => {
  const f = fixture(); f.context.failure.bodyStartedAt = performance.now() - 13000;
  expect(await f.run()).toBe(f.original); expect(io.calls).toContain("plain"); expect(io.calls).not.toContain("analyze");
  expect(JSON.parse(f.output()).analyze).toEqual({ skipped: "remaining_budget" });
});
it("returns the original error on interrupted pending connection, then closes late acquisition without queries or writes", async () => {
  const f = fixture(); let release!: () => void; io.connect = new Promise<void>(resolve => { release = resolve; });
  const pending = f.run(); await vi.waitFor(() => expect(io.calls).toContain("connect")); f.controller.abort();
  expect(await pending).toBe(f.original); const output = f.output(); release(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(io.calls.filter(x => x === "end").length).toBeGreaterThanOrEqual(2); expect(io.calls).not.toContain("begin read only"); expect(f.output()).toBe(output);
});
it("does not let a failed artifact sink replace the original error", async () => {
  const f = fixture(); vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("private_sink_canary"); });
  expect(await f.run()).toBe(f.original); expect(io.calls).toContain("end");
});
it("does not fabricate a session when native session lookup is unavailable", async () => {
  const f = fixture(); vi.spyOn(f.client.auth, "getSession").mockResolvedValue({ data: { session: null }, error: null });
  expect(await f.run()).toBe(f.original); expect(io.calls).not.toContain("connect");
});
it.each([
  { name: "qualifies the actual first overview failure", firstSuccess: false, expectedPages: 1, firstStatus: 500, connects: true },
  { name: "rejects page-one failure after the actual successful first1000 rows", firstSuccess: true, expectedPages: 2, firstStatus: 200, connects: false },
])("$name", async testCase => {
  const f = fixture(); let pages = 0; let originalObserved: unknown;
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    let body: unknown = [];
    if (url.pathname.endsWith("current_business_date")) body = "2026-11-13";
    if (url.pathname.endsWith("document_overview")) {
      if (++pages === 2 || !testCase.firstSuccess) return new Response(JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }), { status: 500 });
      body = Array.from({ length: 1000 }, () => ({ id: crypto.randomUUID(), source_file_id: null, first_page: null, last_page: null, status: "uploaded", created_at: "2026-11-13T00:00:00Z", direction: null, reporting_payload: null, reporting_findings: [] }));
    }
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const diagnostics = startSupabaseRequestDiagnostics(); diagnostics.setPhase("readback_assertions");
  f.context.failure.firstFailure = diagnostics.firstFailure;
  f.context.failure.firstOverviewReadback = () => (diagnostics as unknown as { firstOverviewReadback?: () => unknown }).firstOverviewReadback?.();
  f.context.failure.observeOriginal = error => { originalObserved = error; diagnostics.observeFailure(error); };
  vi.spyOn(console, "error").mockImplementation(() => {});
  let caught: unknown;
  try { await withDocumentOverviewFailure(f.client, "22222222-2222-4222-8222-222222222222", () => listCompanyDocuments(f.client, "22222222-2222-4222-8222-222222222222"), f.context); }
  catch (error) { caught = error; }
  finally { diagnostics.finish(); }
  expect(pages).toBe(testCase.expectedPages); expect(caught).toBe(originalObserved); expect(caught).toMatchObject({ code: "57014" });
  expect(diagnostics.firstOverviewReadback()).toMatchObject({ ordinal: 1, completed: true, status: testCase.firstStatus });
  expect(io.calls.includes("connect")).toBe(testCase.connects);
});
it("does not retain the obsolete plan flag's success or failure collector/sink", async () => {
  const f = fixture(); vi.stubEnv("IVAT_DOCUMENT_OVERVIEW_FAILURE_CAPTURE", "0"); vi.stubEnv("IVAT_DOCUMENT_OVERVIEW_PLAN", "1");
  expect(await f.run()).toBe(f.original); expect(io.calls).toEqual(["public_finally"]);
  expect(fs.existsSync(path.join(f.root, "test-results/document-overview-plan.json"))).toBe(false);
});
it("retains the original error when metadata rejects and still closes the connection", async () => {
  const f = fixture(); io.rejectMetadata = true; expect(await f.run()).toBe(f.original);
  expect(io.calls).not.toContain("plain"); expect(io.calls).toContain("end"); expect(f.output()).not.toContain("private_metadata_canary");
  expect(io.calls.at(-1)).toBe("public_finally");
});
it("continues core metadata and authenticated plans after the actual optional build permission error", async () => {
  const f = fixture(); io.denyBuild = true; expect(await f.run()).toBe(f.original);
  const report = JSON.parse(f.output());
  expect(report.metadata).toMatchObject({ jitAvailable: true, documents: 1002, withLlvm: null, withoutLlvm: null });
  expect(report.optionalMetadata.buildConfig).toEqual({ available: false, sqlState: "42501" });
  expect(io.calls.filter(x => ["plain", "analyze"].includes(x))).toEqual(["plain", "analyze"]);
  expect(io.calls).toContain("rollback to savepoint overview_build_config"); expect(io.calls.at(-1)).toBe("public_finally");
  expect(f.output()).not.toMatch(/private_build_denial_canary|permission denied/);
});
it.each(["rollback to savepoint overview_build_config", "release savepoint overview_build_config"])("fails closed when optional metadata cleanup %s rejects", async command => {
  const f = fixture(); io.denyBuild = true; io.rejectQuery = command; expect(await f.run()).toBe(f.original);
  expect(io.calls).toContain(command); expect(io.calls).not.toContain("plain"); expect(io.calls).toContain("end"); expect(io.calls.at(-1)).toBe("public_finally");
  expect(JSON.parse(f.output())).toMatchObject({ unavailable: true });
});
it("bounds a pending optional field and rejects late results without inventing its SQLSTATE", async () => {
  const f = fixture(); let release!: () => void; io.build = new Promise<void>(resolve => { release = resolve; });
  const pending = f.run(); await vi.waitFor(() => expect(io.calls.some(call => call.startsWith("select setting from pg_config"))).toBe(true)); f.controller.abort();
  expect(await pending).toBe(f.original); const output = f.output(); release(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(io.calls).not.toContain("plain"); expect(f.output()).toBe(output);
  expect(JSON.parse(output).optionalMetadata.buildConfig).toMatchObject({ available: false, sqlState: null });
});
it.each(["rollback", "release savepoint overview_probe"])("retains the original error and closes when %s rejects", async command => {
  const f = fixture(); io.rejectQuery = command; expect(await f.run()).toBe(f.original);
  expect(io.calls).toContain(command); expect(io.calls).toContain("end"); expect(f.output()).not.toContain("private_cleanup_canary");
  expect(io.calls.at(-1)).toBe("public_finally");
});
it("still closes after both a plain failure and savepoint rollback rejection", async () => {
  const f = fixture(); io.failPlain = true; io.rejectQuery = "rollback to savepoint overview_probe";
  expect(await f.run()).toBe(f.original); expect(io.calls).toContain(io.rejectQuery); expect(io.calls).toContain("end"); expect(io.calls).not.toContain("analyze");
});
it("keeps close rejection explicit without replacing the original error", async () => {
  const f = fixture(); io.rejectClose = true; expect(await f.run()).toBe(f.original);
  expect(io.calls).toContain("end"); expect(JSON.parse(f.output())).toMatchObject({ closeUnavailable: true });
  expect(io.calls.at(-1)).toBe("public_finally");
});
it("refuses malformed, mismatched and unsupported issued claims before connection", async () => {
  for (const payload of ["not-json", JSON.stringify({ role: "service_role", sub: "11111111-1111-4111-8111-111111111111" }), JSON.stringify({ role: "authenticated", sub: "different", session_id: "private_session_canary", aal: "aal1" }), JSON.stringify({ role: "authenticated", sub: "11111111-1111-4111-8111-111111111111", session_id: "private_session_canary", aal: "unsupported" })]) {
    const f = fixture(); vi.spyOn(f.client.auth, "getSession").mockResolvedValue({ data: { session: { access_token: `head.${Buffer.from(payload).toString("base64url")}.signature`, user: { id: "11111111-1111-4111-8111-111111111111" } } as Session }, error: null });
    expect(await f.run()).toBe(f.original); expect(io.calls).not.toContain("connect");
  }
});
it("refuses unsupported or missing actual body deadlines without DB work", async () => {
  for (const timeout of [10000, undefined, Number.NaN]) {
    const f = fixture(); f.context.failure.timeoutMs = timeout as number; expect(await f.run()).toBe(f.original);
    expect(io.calls).not.toContain("connect"); expect(JSON.parse(f.output())).toMatchObject({ skipped: "unsupported_deadline" });
  }
  for (const started of [undefined, Number.NaN, Infinity, performance.now() + 10000]) {
    const f = fixture(); f.context.failure.bodyStartedAt = started as number; expect(await f.run()).toBe(f.original);
    expect(io.calls).not.toContain("connect"); expect(JSON.parse(f.output())).toMatchObject({ skipped: "unsupported_deadline" });
  }
});
it("enforces its hard deadline on a pending acquisition and prevents later queries or artifact writes", async () => {
  const f = fixture(); let release!: () => void; io.connect = new Promise<void>(resolve => { release = resolve; });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = f.run(); await vi.waitFor(() => expect(io.calls).toContain("connect"));
  await vi.advanceTimersByTimeAsync(5000); expect(await pending).toBe(f.original); const output = f.output(); release(); await vi.advanceTimersByTimeAsync(0);
  expect(io.calls.filter(x => x === "end").length).toBeGreaterThanOrEqual(2); expect(io.calls).not.toContain("begin read only"); expect(f.output()).toBe(output);
});
it("closes an interrupted metadata query without accepting late results or altering the artifact", async () => {
  const f = fixture(); let release!: () => void; io.metadata = new Promise<void>(resolve => { release = resolve; });
  const pending = f.run(); await vi.waitFor(() => expect(io.calls.some(call => call.includes("server_version_num"))).toBe(true)); f.controller.abort();
  expect(await pending).toBe(f.original); const output = f.output(); release(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.output()).toBe(output); expect(io.calls).not.toContain("plain");
});
it("uses the installed runner's separate body deadline while aroundEach excludes the awaited body from its hook timer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-runner-budget-")); roots.push(root);
  const entry = path.resolve("node_modules/vitest/dist/index.js");
  fs.writeFileSync(path.join(root, "runner.test.ts"), `import {aroundEach,afterAll,it,expect} from ${JSON.stringify(entry)};
    const events=[]; aroundEach(async run=>{events.push('ready');await run();events.push('closed');},10);
    it('native body deadline',async({task})=>{expect(task.timeout).toBe(1000);await new Promise(r=>setTimeout(r,35));events.push('body');});
    afterAll(()=>expect(events).toEqual(['ready','body','closed']));`);
  const config = path.join(root, "vitest.config.mjs");
  fs.writeFileSync(config, `export default {root:${JSON.stringify(root)},test:{include:['runner.test.ts'],globalSetup:[],testTimeout:1000,maxWorkers:1}};`);
  const result = execFileSync(process.execPath, [path.resolve("node_modules/vitest/vitest.mjs"), "run", "--config", config], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
  expect(result).toMatch(/1 passed/);
});
