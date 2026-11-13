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
  let acceptLog: (chunk: string) => void = () => {};
  let sample = async () => [{ wait_event_type: "Lock", blocker_count: 2, query: "private_query_canary", pid: 123456 }];
  let failConnect = false;
  const io: CaptureTransport = {
    context() { calls.push("git_context"); return { isLinkedWorktree: true, generatedWorkdir: root }; },
    config() { return 'project_id = "ivat-wt80"\n[api]\nport = 62321\n[db]\nport = 62322'; },
    async inspect() { calls.push("docker_inspect"); return { "5432/tcp": [{ HostPort: "62322" }] }; },
    logs(_container, _since, accept) { calls.push("docker_logs_open"); acceptLog = accept; return () => { calls.push("docker_logs_close"); }; },
    async connect() {
      calls.push("pg_connect"); if (failConnect) throw new Error("private_connect_canary");
      return { async sample() { calls.push("pg_sample"); return sample(); }, async close() { calls.push("pg_close"); } };
    },
  };
  const event = {
    name: operationalBulkCase, module: { moduleId: path.join(root, "tests/operational-email-alerts.test.ts") },
    project: { config: { root }, getProvidedContext: () => ({ supabaseUrl: "http://127.0.0.1:62321", databaseUrl: "postgresql://private_password_canary@127.0.0.1:62322/postgres" }) },
    logs: () => logs,
  };
  return {
    root, calls, event, logs, io,
    reporter: new OperationalBulkCapture(io, { IVAT_OPERATIONAL_BULK_CAPTURE: "1" }),
    serverLog(bytes: string) { acceptLog(bytes); },
    blockSample() { let release!: (rows: Awaited<ReturnType<typeof sample>>) => void; const result = new Promise<Awaited<ReturnType<typeof sample>>>(resolve => { release = resolve; }); sample = () => result; return () => release([{ wait_event_type: "Lock", blocker_count: 9, query: "private_late_canary", pid: 456789 }]); },
    failConnection() { failConnect = true; },
    output(file: string) { const target = path.join(root, "test-results/operational-bulk-capture", file); return fs.existsSync(target) ? fs.readFileSync(target, "utf8") : ""; },
    remove() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}
