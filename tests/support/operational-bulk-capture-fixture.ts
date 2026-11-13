import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OperationalBulkCapture, { type CaptureTransport } from "./operational-bulk-capture";
import { operationalBulkCase } from "./operational-bulk-protocol";

/** Controlled Docker/PG boundaries; no application or DB connection is started. */
export function operationalCaptureFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-capture-boundary-"));
  const calls: string[] = [];
  const logs: { content: string }[] = [];
  const serverChunks: string[] = [];
  const windows: { since: string; until: string }[] = [];
  let inspectBarrier: Promise<void> | undefined, connectBarrier: Promise<void> | undefined;
  let sample = async () => [{ wait_event_type: "Lock", blocker_count: 2, query: "private_query_canary", pid: 123456 }];
  let failConnect = false;
  const io: CaptureTransport = {
    context() { calls.push("git_context"); return { isLinkedWorktree: true, generatedWorkdir: root }; },
    config() { return 'project_id = "ivat-wt80"\n[api]\nport = 62321\n[db]\nport = 62322'; },
    async inspect() { calls.push("docker_inspect"); await inspectBarrier; return { "5432/tcp": [{ HostPort: "62322" }] }; },
    async logs(_container, since, until, accept) { calls.push("docker_logs_snapshot"); windows.push({ since, until }); for (const chunk of serverChunks) accept(chunk); },
    async connect() {
      calls.push("pg_connect"); await connectBarrier; if (failConnect) throw new Error("private_connect_canary");
      return { async sample() { calls.push("pg_sample"); return sample(); }, async catalog() { calls.push("pg_catalog"); return { server_version_num: "170011", server_build: "PostgreSQL x86_64 private_build_canary", jit: "on", jit_provider: "llvmjit", jit_above_cost: "100000", jit_inline_above_cost: "500000", jit_optimize_above_cost: "500000", plan_cache_mode: "auto", native_role_limits: true, jitAvailability: { available: true, value: true, sqlState: null }, private_token_canary: "private_password_canary" }; }, async close() { calls.push("pg_close"); } };
    },
  };
  const event = {
    name: operationalBulkCase, moduleId: path.join(root, "tests/operational-email-alerts.test.ts"), root,
    provided: { supabaseUrl: "http://127.0.0.1:62321", databaseUrl: "postgresql://private_password_canary@127.0.0.1:62322/postgres" },
  };
  return {
    root, calls, event, logs, io, windows,
    reporter: new OperationalBulkCapture(io, { IVAT_OPERATIONAL_BULK_CAPTURE: "1", IVAT_POST_CLEANUP_CATALOG: "1" }),
    serverLog(bytes: string) { serverChunks.push(bytes); },
    blockInspect() { let release!: () => void; inspectBarrier = new Promise<void>(resolve => { release = resolve; }); return release; },
    blockConnect() { let release!: () => void; connectBarrier = new Promise<void>(resolve => { release = resolve; }); return release; },
    blockSample() { let release!: (rows: Awaited<ReturnType<typeof sample>>) => void; const result = new Promise<Awaited<ReturnType<typeof sample>>>(resolve => { release = resolve; }); sample = () => result; return () => release([{ wait_event_type: "Lock", blocker_count: 9, query: "private_late_canary", pid: 456789 }]); },
    failConnection() { failConnect = true; },
    output(file: string) { const target = path.join(root, "test-results/operational-bulk-capture", file); return fs.existsSync(target) ? fs.readFileSync(target, "utf8") : ""; },
    remove() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}
