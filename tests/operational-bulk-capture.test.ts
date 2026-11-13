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
  const diagnostic = { ...ci, environment: { ...ci.environment, GITHUB_JOB: "operational-bulk-diagnostic", GITHUB_HEAD_REF: "fix/operational-post-cleanup-catalog-344", IVAT_POST_CLEANUP_CATALOG: "1", IVAT_OPERATIONAL_DIAGNOSTIC_MODE: "post_cleanup_catalog_344" } };
  expect(validateCaptureContext(diagnostic).container).toBe("supabase_db_ivat");
  const missingMode: Record<string, string | undefined> = { ...diagnostic.environment }; delete missingMode.IVAT_OPERATIONAL_DIAGNOSTIC_MODE;
  for (const environment of [missingMode, { ...diagnostic.environment, IVAT_POST_CLEANUP_CATALOG: "" }, { ...diagnostic.environment, GITHUB_HEAD_REF: "another" }, { ...diagnostic.environment, GITHUB_JOB: "another" }, { ...diagnostic.environment, IVAT_OPERATIONAL_DIAGNOSTIC_MODE: "" }, { ...diagnostic.environment, IVAT_OPERATIONAL_DIAGNOSTIC_MODE: "wrong" }]) {
    expect(() => validateCaptureContext({ ...diagnostic, environment })).toThrow("capture context unavailable");
  }
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
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, vi } from "vitest";
import OperationalBulkCapture from "./support/operational-bulk-capture";
import { operationalCaptureFixture } from "./support/operational-bulk-capture-fixture";
import { postCleanupCatalogFixture } from "./support/post-cleanup-catalog-fixture";
const captures: ReturnType<typeof operationalCaptureFixture>[] = [];
afterEach(async () => { for (const fixture of captures.splice(0)) { await fixture.reporter.end("run_finished"); fixture.remove(); } vi.useRealTimers(); });
const capture = () => { const fixture = operationalCaptureFixture(); captures.push(fixture); return fixture; };

it("collects catalog facts after successful cleanup without another business read or plan", async () => {
  const fixture = capture();
  await fixture.reporter.begin(fixture.event);
  await fixture.settledCatalog();
  await fixture.reporter.end();
  expect(fixture.calls).toEqual(["git_context", "docker_inspect", "pg_connect", "pg_catalog", "pg_close", "docker_logs_snapshot"]);
  expect(JSON.parse(fixture.output("catalog.jsonl"))).toEqual({
    source: "diagnostic_session", phase: "post_cleanup", originalEffectiveSettingsCaptured: false,
    originalJitUseCaptured: false, originalPlanStatisticsCaptured: false, serverVersionNum: 170011, architecture: "x86_64",
    jit: true, jitProvider: "llvmjit", jitAboveCost: 100000, jitInlineAboveCost: 500000, jitOptimizeAboveCost: 500000,
    planCacheMode: "auto", jitAvailability: { available: true, value: true, sqlState: null },
    nativeRoleLimits: true,
    statistics: { available: false, sqlState: null, relations: [] },
  });
  expect(fixture.output("catalog.jsonl")).not.toMatch(/private_\w+_canary|password|\bquery\b|\bpid\b/);
});

it("leaves the catalog disabled without its separate opt-in or after capture stops", async () => {
  const fixture = capture();
  const disabled = new OperationalBulkCapture(fixture.io, { IVAT_OPERATIONAL_BULK_CAPTURE: "1" });
  await disabled.begin(fixture.event); await disabled.postCleanupCatalog(); await disabled.end();
  expect(fixture.calls).not.toContain("pg_catalog");
  await fixture.settledCatalog();
  expect(fixture.calls).not.toContain("pg_catalog");
});

it.each(["body", "cleanup", "aborted"])("skips immediately with %s completion unproven or cancelled and never retries late completion", async missing => {
  const fixture = capture(); const controller = new AbortController();
  await fixture.reporter.begin(fixture.event);
  if (missing !== "body") fixture.reporter.bodyFinished(controller.signal);
  if (missing !== "cleanup") fixture.reporter.cleanupFinished();
  if (missing === "aborted") controller.abort();
  await fixture.reporter.postCleanupCatalog();
  expect(fixture.calls).not.toContain("pg_catalog");
  const output = fixture.output("catalog.jsonl");
  expect(JSON.parse(output)).toEqual({ source: "diagnostic_session", skipped: missing === "aborted" ? "aborted" : "completion_unproven" });
  await fixture.reporter.end();
  const calls = [...fixture.calls];
  fixture.reporter.bodyFinished(new AbortController().signal); fixture.reporter.cleanupFinished();
  await fixture.reporter.postCleanupCatalog();
  expect(fixture.calls).toEqual(calls); expect(fixture.output("catalog.jsonl")).toBe(output);
});

it("cancels a catalog already in flight when the original native body signal aborts", async () => {
  const fixture = capture(); const connect = fixture.io.connect; const controller = new AbortController();
  let opened!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { opened = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  fixture.io.connect = async url => ({ ...await connect(url), async catalog() { opened(); await pending; return { server_build: "private_late_canary" }; } });
  await fixture.reporter.begin(fixture.event);
  const finish = fixture.settledCatalog(controller.signal); await ready; controller.abort(); await finish;
  expect(JSON.parse(fixture.output("catalog.jsonl"))).toMatchObject({ unavailable: true, deadlineExpired: false, sqlState: null });
  const output = fixture.output("catalog.jsonl"); await fixture.reporter.end(); release(); await Promise.resolve();
  expect(fixture.output("catalog.jsonl")).toBe(output); expect(fixture.calls.filter(c => c === "pg_close")).toHaveLength(1);
});

it("waits for the last sample before catalog collection and discards its late target-window row", async () => {
  vi.useFakeTimers();
  const fixture = capture(); const release = fixture.blockSample();
  await fixture.reporter.begin(fixture.event); await vi.advanceTimersByTimeAsync(100);
  const finish = fixture.settledCatalog();
  expect(fixture.calls).not.toContain("pg_catalog");
  release(); await finish; await fixture.reporter.end();
  expect(fixture.calls.filter(call => call === "pg_catalog")).toHaveLength(1);
  expect(fixture.output("waits.jsonl")).toBe("");
});

it.each(["sample", "catalog"])("bounds pending %s work, closes the owned connection and prevents late catalog writes", async boundary => {
  vi.useFakeTimers();
  const fixture = capture();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  if (boundary === "sample") {
    const unblock = fixture.blockSample(); release = unblock;
  } else {
    const connect = fixture.io.connect;
    fixture.io.connect = async url => ({ ...await connect(url), async catalog() { fixture.calls.push("pg_catalog"); await barrier; return { server_build: "private_late_canary" }; } });
  }
  await fixture.reporter.begin(fixture.event);
  if (boundary === "sample") await vi.advanceTimersByTimeAsync(100);
  let completed = false;
  const finish = fixture.settledCatalog().then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(1000); await finish;
  expect(completed).toBe(true);
  expect(JSON.parse(fixture.output("catalog.jsonl"))).toMatchObject({ unavailable: true, deadlineExpired: true });
  expect(fixture.calls.filter(call => call === "pg_close")).toHaveLength(1);
  const output = fixture.output("catalog.jsonl");
  release(); await vi.advanceTimersByTimeAsync(1000); await fixture.reporter.end();
  expect(fixture.output("catalog.jsonl")).toBe(output);
});

it("cancels a pending catalog on owned runner exit without a late write or second close", async () => {
  const fixture = capture(); const connect = fixture.io.connect;
  let release!: () => void, opened!: () => void;
  const ready = new Promise<void>(resolve => { opened = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  fixture.io.connect = async url => ({ ...await connect(url), async catalog() { opened(); await pending; return {}; } });
  await fixture.reporter.begin(fixture.event);
  const finish = fixture.settledCatalog(); await ready;
  await fixture.reporter.end("runner_exit"); await finish;
  release(); await Promise.resolve();
  expect(fixture.output("catalog.jsonl")).toBe("");
  expect(fixture.calls.filter(call => call === "pg_close")).toHaveLength(1);
});

it("keeps catalog/close rejection diagnostic-only and strips unexpected metadata", async () => {
  const fixture = capture(); const connect = fixture.io.connect;
  fixture.io.connect = async url => ({ ...await connect(url), async catalog() { throw new Error("private_catalog_canary"); }, async close() { throw new Error("private_close_canary"); } });
  const original = Object.assign(new Error("original business error"), { code: "57014" });
  let cleanup = false;
  await fixture.reporter.begin(fixture.event);
  const execute = async () => { try { throw original; } finally { cleanup = true; await fixture.settledCatalog(); await fixture.reporter.end(); } };
  await expect(execute()).rejects.toBe(original); expect(cleanup).toBe(true);
  expect(JSON.parse(fixture.output("catalog.jsonl"))).toMatchObject({ unavailable: true });
  expect(fixture.output("catalog.jsonl")).not.toContain("private_");
});

it("checks optional JIT EXECUTE permission before calling it without inferring a denied SQLSTATE", async () => {
  const fixture = postCleanupCatalogFixture(); fixture.denyJit();
  const result = await fixture.read();
  expect(result.jitAvailability).toEqual({ available: false, value: null, sqlState: null });
  expect(fixture.calls).not.toContain("jit");
  expect(result.statistics.available).toBe(true);
  expect(fixture.calls.at(-1)).toBe("rollback");
});

it.each(["jit", "statistics"])("isolates a genuine optional %s 42501 while keeping required metadata and rollback", async stage => {
  const fixture = postCleanupCatalogFixture(); fixture.fail(stage);
  const result = await fixture.read();
  expect(result.server_version_num).toBe("170011");
  expect(stage === "jit" ? result.jitAvailability : result.statistics).toMatchObject({ available: false, sqlState: "42501" });
  expect(fixture.calls).toContain("rollback_optional"); expect(fixture.calls).toContain("release_optional");
  expect(fixture.calls.at(-1)).toBe("rollback");
});

it.each(["metadata", "rollback_optional", "release_optional", "rollback"])("fails catalog closed on an actual %s rejection", async stage => {
  const fixture = postCleanupCatalogFixture();
  if (stage !== "metadata" && stage !== "rollback") fixture.fail("jit");
  const error = fixture.fail(stage);
  await expect(fixture.read()).rejects.toBe(error);
});

it("marks absent optional statistics unavailable without reading their catalog view", async () => {
  const fixture = postCleanupCatalogFixture(); fixture.denyStatistics();
  const result = await fixture.read();
  expect(result.statistics).toEqual({ available: false, relations: [], sqlState: null });
  expect(fixture.calls).not.toContain("statistics");
});

it("bounds a nonsettling owned close within the catalog's one-second work-and-close allowance", async () => {
  vi.useFakeTimers();
  const fixture = capture(); const connect = fixture.io.connect;
  fixture.io.connect = async url => ({ ...await connect(url), async catalog() { await new Promise(() => {}); }, async close() { fixture.calls.push("pg_close"); await new Promise(() => {}); } });
  await fixture.reporter.begin(fixture.event);
  let completed = false;
  const finish = fixture.settledCatalog().then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(999); expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await finish;
  expect(completed).toBe(true);
  expect(JSON.parse(fixture.output("catalog.jsonl"))).toMatchObject({ unavailable: true, deadlineExpired: true });
  await fixture.reporter.end();
  expect(fixture.calls.filter(call => call === "pg_close")).toHaveLength(1);
});

it("sanitizes post-cleanup statistics and unknown build/config fields before the artifact sink", async () => {
  const fixture = capture(); const connect = fixture.io.connect;
  fixture.io.connect = async url => ({ ...await connect(url), async catalog() { return {
    server_build: "private_compiler_canary", server_version_num: "private_version_canary", jit: "private_jit_canary", jit_provider: "private_provider_canary", plan_cache_mode: "private_plan_canary",
    jitAvailability: { available: false, value: true, sqlState: "private_error_canary" },
    statistics: { available: true, sqlState: "private_error_canary", relations: [
      { relation: "document", rows: -1, pages: 0, analyze_count: 1, autoanalyze_count: 2, last_autoanalyze_age_ms: 3000, id: "private_id_canary", timestamp: "private_time_canary" },
      { relation: "private_relation_canary", rows: 100 },
    ] },
  }; } });
  await fixture.reporter.begin(fixture.event); await fixture.settledCatalog(); await fixture.reporter.end();
  const output = fixture.output("catalog.jsonl"); expect(output).not.toContain("private_");
  expect(JSON.parse(output)).toMatchObject({
    architecture: null, serverVersionNum: null, jit: null, jitProvider: null, planCacheMode: null,
    jitAvailability: { available: false, value: null, sqlState: null },
    statistics: { available: true, sqlState: null, relations: [{ relation: "document", rows: -1, pages: 0, analyzeCount: 1, autoanalyzeCount: 2, lastAutoanalyzeAgeMs: 3000 }] },
  });
});

it("the installed worker retains body and afterEach failures while post-cleanup catalog failure stays diagnostic", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-catalog-runner-"));
  try {
    const vitest = path.resolve("node_modules/vitest/dist/index.js");
    const fixture = path.resolve("tests/support/operational-bulk-capture-fixture.ts");
    fs.writeFileSync(path.join(root, "runner.test.ts"), `import {aroundEach,afterEach,afterAll,it} from ${JSON.stringify(vitest)};
      import fs from 'node:fs';import {operationalCaptureFixture} from ${JSON.stringify(fixture)};
      const events=[];let current;
      aroundEach(async(run,{task})=>{const f=operationalCaptureFixture();current=f;const connect=f.io.connect;
        f.io.connect=async url=>({...await connect(url),async catalog(){events.push(task.name+':catalog');throw new Error('private_catalog_canary');}});
        await f.reporter.begin(f.event);try{await run();}finally{await f.reporter.postCleanupCatalog();await f.reporter.end();events.push(task.name+':closed');f.remove();}});
      afterEach(({task})=>{const own=current;try{events.push(task.name+':afterEach');if(task.name==='cleanup original')throw new Error('original_cleanup_failure');}finally{own.reporter.cleanupFinished();}});
      it('body original',({signal})=>{const own=current;try{events.push('body original:body');throw new Error('original_body_failure');}finally{events.push('body original:finally');own.reporter.bodyFinished(signal);}});
      it('cleanup original',({signal})=>{const own=current;try{events.push('cleanup original:body');}finally{events.push('cleanup original:finally');own.reporter.bodyFinished(signal);}});
      afterAll(()=>fs.writeFileSync(${JSON.stringify(path.join(root, "events.json"))},JSON.stringify(events)));`);
    fs.writeFileSync(path.join(root, "vitest.config.mjs"), `export default {root:${JSON.stringify(root)},test:{include:['runner.test.ts'],globalSetup:[],testTimeout:20000,maxWorkers:1}};`);
    const result = spawnSync(process.execPath, [path.resolve("node_modules/vitest/vitest.mjs"), "run", "--config", path.join(root, "vitest.config.mjs"), "--reporter=json", "--outputFile", path.join(root, "results.json")], { encoding: "utf8", timeout: 10000 });
    expect(result.status).toBe(1);
    const report = fs.readFileSync(path.join(root, "results.json"), "utf8");
    expect(report).toContain("original_body_failure"); expect(report).toContain("original_cleanup_failure"); expect(report).not.toContain("private_catalog_canary");
    expect(JSON.parse(fs.readFileSync(path.join(root, "events.json"), "utf8"))).toEqual([
      "body original:body", "body original:finally", "body original:afterEach", "body original:catalog", "body original:closed",
      "cleanup original:body", "cleanup original:finally", "cleanup original:afterEach", "cleanup original:catalog", "cleanup original:closed",
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("the installed worker skips catalog when native timeout returns before the real body-finally or afterEach settles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-catalog-timeout-"));
  try {
    const vitest = path.resolve("node_modules/vitest/dist/index.js");
    const fixture = path.resolve("tests/support/operational-bulk-capture-fixture.ts");
    fs.writeFileSync(path.join(root, "runner.test.ts"), `import {aroundEach,afterEach,afterAll,it} from ${JSON.stringify(vitest)};
      import fs from 'node:fs';import {operationalCaptureFixture} from ${JSON.stringify(fixture)};
      const events=[],closed=[];let current;const delay=ms=>new Promise(r=>setTimeout(r,ms));
      aroundEach(async(run,{task})=>{const f=operationalCaptureFixture();current=f;await f.reporter.begin(f.event);
        try{await run();}finally{events.push(task.name+':wrapper-return');await f.reporter.postCleanupCatalog();await f.reporter.end();
          events.push(task.name+':closed');closed.push({f,calls:[...f.calls],output:f.output('catalog.jsonl')});current=undefined;}});
      afterEach(async({task})=>{const own=current;
        try{if(task.name==='cleanup pending')await delay(5);}finally{
          if(task.name==='cleanup pending'){events.push('cleanup:finally-start');await delay(80);events.push('cleanup:finally-end');}
          own.reporter.cleanupFinished();}},25);
      it('body pending',async({signal})=>{const own=current;try{await delay(5);}finally{
        events.push('body:finally-start');await delay(80);events.push('body:finally-end');own.reporter.bodyFinished(signal);}},25);
      it('cleanup pending',async({signal})=>{const own=current;try{}finally{own.reporter.bodyFinished(signal);}},20000);
      afterAll(async()=>{await delay(150);fs.writeFileSync(${JSON.stringify(path.join(root, "events.json"))},JSON.stringify({events,
        results:closed.map(({f,calls,output})=>({catalogCalls:f.calls.filter(x=>x==='pg_catalog').length,
          callsStable:JSON.stringify(calls)===JSON.stringify(f.calls),outputStable:output===f.output('catalog.jsonl')}))}));for(const {f}of closed)f.remove();});`);
    fs.writeFileSync(path.join(root, "vitest.config.mjs"), `export default {root:${JSON.stringify(root)},test:{include:['runner.test.ts'],globalSetup:[],testTimeout:20000,maxWorkers:1}};`);
    const result = spawnSync(process.execPath, [path.resolve("node_modules/vitest/vitest.mjs"), "run", "--config", path.join(root, "vitest.config.mjs"), "--reporter=json", "--outputFile", path.join(root, "results.json")], { encoding: "utf8", timeout: 10000 });
    expect(result.status).toBe(1);
    const report = fs.readFileSync(path.join(root, "results.json"), "utf8");
    expect(report).toContain("Test timed out in 25ms"); expect(report).toContain("Hook timed out in 25ms");
    const packet = JSON.parse(fs.readFileSync(path.join(root, "events.json"), "utf8"));
    expect(packet.events.indexOf("body pending:closed")).toBeLessThan(packet.events.indexOf("body:finally-end"));
    expect(packet.events.indexOf("cleanup pending:closed")).toBeLessThan(packet.events.indexOf("cleanup:finally-end"));
    expect(packet.results).toEqual([{ catalogCalls: 0, callsStable: true, outputStable: true }, { catalogCalls: 0, callsStable: true, outputStable: true }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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
  let ownCapture: ReturnType<typeof operationalCaptureFixture>;
  aroundEach(async run => {
    const fixture = operationalCaptureFixture(); ownCapture = fixture;
    const inspect = fixture.io.inspect;
    fixture.io.inspect = async container => { order.push("inspect-start"); await new Promise(resolve => setTimeout(resolve, 10)); const ports = await inspect(container); order.push("inspect-finish"); return ports; };
    const connect = fixture.io.connect;
    fixture.io.connect = async url => { const client = await connect(url); order.push("pg-ready"); return { sample: client.sample, async catalog(active) { order.push("post-cleanup-catalog"); return client.catalog(active); }, async close() { order.push("pg-close"); await client.close(); } }; };
    const logs = fixture.io.logs;
    fixture.io.logs = async (...args) => { order.push("snapshot"); await logs(...args); };
    await fixture.reporter.begin(fixture.event);
    try { await run(); }
    finally { await fixture.reporter.postCleanupCatalog(); await fixture.reporter.end(); order.push("capture-closed"); fixture.remove(); }
  });
  beforeEach(() => { order.push("beforeEach-fixture"); });
  afterEach(() => { try { order.push("afterEach-cleanup"); } finally { ownCapture.reporter.cleanupFinished(); } });
  it("awaits readiness before the first fixture and drains only after every hook", ({ signal }) => { const own = ownCapture; try { order.push("body"); } finally { order.push("body-finally"); own.reporter.bodyFinished(signal); } });
  afterAll(() => {
    expect(order).toEqual(["inspect-start", "inspect-finish", "pg-ready", "beforeEach-fixture", "body", "body-finally", "afterEach-cleanup", "post-cleanup-catalog", "pg-close", "snapshot", "capture-closed"]);
  });
});

it("stops through its registered process-exit boundary without acquiring a new log reader", async () => {
  vi.useFakeTimers();
  const fixture = capture(); const existing = new Set(process.listeners("exit"));
  await fixture.reporter.begin(fixture.event);
  const handlers = process.listeners("exit").filter(handler => !existing.has(handler));
  expect(handlers).toHaveLength(1);
  handlers[0](0); // Invoke only this fixture's OS boundary; do not terminate Vitest.
  await vi.advanceTimersByTimeAsync(1000);
  await fixture.reporter.end("runner_exit");
  expect(fixture.calls.filter(call => call === "pg_close")).toHaveLength(1);
  expect(fixture.calls).not.toContain("pg_sample");
  expect(fixture.calls).not.toContain("docker_logs_snapshot");
});

it("aborts an already draining log reader when the worker exits", async () => {
  const fixture = capture(); const existing = new Set(process.listeners("exit"));
  let opened!: () => void;
  const open = new Promise<void>(resolve => { opened = resolve; });
  let aborted = false;
  fixture.io.logs = async (_container, _since, _until, _accept, signal) => {
    opened();
    await new Promise<void>(resolve => signal!.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
  };
  await fixture.reporter.begin(fixture.event);
  const finish = fixture.reporter.end(); await open;
  const handler = process.listeners("exit").find(value => !existing.has(value))!;
  handler(0); await finish;
  expect(aborted).toBe(true);
  expect(fixture.calls.filter(call => call === "pg_close")).toHaveLength(1);
});
