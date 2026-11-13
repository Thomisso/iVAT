import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";
import type { Reporter } from "vitest/node";
import type { UserConsoleLog } from "vitest";
import { localSupabaseContext } from "../../scripts/supabase-status.mjs";
import { operationalBulkCase, requestTestPhases } from "./operational-bulk-protocol";

const unavailable = () => new Error("capture context unavailable");
const loopback = (host: string) => ["127.0.0.1", "localhost", "[::1]"].includes(host);
type ContextInput = { linked: boolean; root: string; workspace: string; environment: Record<string, string | undefined>; config: string; provided: { supabaseUrl: string; databaseUrl: string } };
/** Validation precedes Docker/PG access. Credentials are returned privately only. */
export function validateCaptureContext(input: ContextInput) {
  try {
    const project = input.config.match(/^project_id\s*=\s*"([a-z][a-z0-9_-]{0,62})"/m)?.[1];
    const port = (section: string) => input.config.match(new RegExp(`^\\[${section}\\]\\s*\\n(?:(?!\\[).|\\n)*?^port\\s*=\\s*(\\d+)`, "m"))?.[1];
    const api = new URL(input.provided.supabaseUrl), db = new URL(input.provided.databaseUrl);
    if (!project || !loopback(api.hostname) || !loopback(db.hostname) || api.protocol !== "http:" || api.username || api.password || !["postgres:", "postgresql:"].includes(db.protocol) || api.port !== port("api") || db.port !== port("db")) throw unavailable();
    if (input.linked) {
      if (!/^ivat-wt[1-9][0-9]?$/.test(project)) throw unavailable();
    } else {
      const env = input.environment;
      if (env.CI !== "true" || env.GITHUB_ACTIONS !== "true" || !/^\d+$/.test(env.GITHUB_RUN_ID ?? "") || env.GITHUB_JOB !== "full" || input.workspace !== input.root) throw unavailable();
    }
    return { container: `supabase_db_${project}`, databasePort: db.port, databaseUrl: input.provided.databaseUrl };
  } catch { throw unavailable(); }
}

type PgFrame = { sqlState: string | null } | { schema: string | null; function: string; line: number };
/** Existing default stderr only; unsupported prefixes/missing codes stay absent.
 * Backend IDs group lines in memory and never leave this parser. */
export function createPostgresFrameReader(emit: (frame: PgFrame) => void) {
  let buffer = "", dropping = false, firstBackend: string | null = null, context = false, frames = 0;
  const line = (value: string) => {
    const prefix = value.match(/^\d{4}-\d\d-\d\d[ T][\d:.+-]+(?:\s+[A-Z]+)?\s+\[(\d+)\]\s+(?:\S+@\S+\s+)?(ERROR|CONTEXT|STATEMENT|DETAIL|HINT|LOCATION|LOG|NOTICE|WARNING):\s*(.*)$/);
    let body = value.trim();
    if (prefix) {
      context = false;
      const [, backend, level, text] = prefix;
      if (level === "ERROR" && firstBackend === null && /^(?:[0-9A-Z]{5}:\s+)?canceling statement due to statement timeout\s*$/.test(text)) {
        firstBackend = backend;
        emit({ sqlState: text.match(/^([0-9A-Z]{5}):/)?.[1] ?? null });
      }
      if (level !== "CONTEXT" || backend !== firstBackend) return;
      context = true; body = text;
    }
    if (!context || frames >= 64) return;
    const match = body.match(/^PL\/pgSQL function ((?:(?:public|private)\.)?[a-z_][a-z0-9_]{0,62})\([^\n]*\) line (\d+)\b/i)
      ?? body.match(/^SQL function "((?:(?:public|private)\.)?[a-z_][a-z0-9_]{0,62})" statement (\d+)\b/i);
    if (match) {
      if (!Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1) return;
      const parts = match[1].split("."); frames++;
      emit({ schema: parts.length === 2 ? parts[0] : null, function: parts.at(-1)!, line: Number(match[2]) });
    }
  };
  return {
    accept(chunk: string) {
      for (const part of chunk.split(/(?<=\n)/)) {
        if (!dropping) buffer += part;
        if (buffer.length > 65536) { buffer = ""; dropping = true; context = false; }
        if (part.endsWith("\n")) { if (!dropping) line(buffer.trimEnd()); buffer = ""; dropping = false; }
      }
    },
    finish() { if (buffer && !dropping) line(buffer); buffer = ""; context = false; },
  };
}

type WaitRow = { wait_event_type: unknown; blocker_count: unknown };
type Connection = { sample(): Promise<WaitRow[]>; close(): Promise<void> };
export type CaptureTransport = {
  context(root: string): { isLinkedWorktree: boolean; generatedWorkdir: string };
  config(file: string): string;
  inspect(container: string): Promise<unknown>;
  logs(container: string, since: string, accept: (chunk: string) => void, failed: () => void): () => void;
  connect(url: string): Promise<Connection>;
};
const exec = promisify(execFile);
const transport: CaptureTransport = {
  context: (root) => localSupabaseContext({ cwd: root }),
  config: (file) => fs.readFileSync(file, "utf8"),
  async inspect(container) {
    const { stdout } = await exec("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", container], { timeout: 2000, maxBuffer: 65536 });
    return JSON.parse(stdout);
  },
  logs(container, since, accept, failed) {
    const child = spawn("docker", ["logs", "--follow", "--since", since, container], { stdio: ["ignore", "pipe", "pipe"] });
    let stopped = false;
    child.stdout.on("data", (bytes: Buffer) => accept(bytes.toString()));
    child.stderr.on("data", (bytes: Buffer) => accept(bytes.toString()));
    child.on("error", failed);
    child.on("close", (code) => { if (!stopped && code !== 0) failed(); });
    return () => { stopped = true; child.kill("SIGTERM"); };
  },
  async connect(url) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 1000, query_timeout: 1000 });
    try { await client.connect(); } catch (error) { await client.end().catch(() => {}); throw error; }
    return {
      async sample() { return (await client.query("select wait_event_type,cardinality(pg_blocking_pids(pid))::int as blocker_count from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and backend_type='client backend' and state<>'idle' limit 32")).rows; },
      async close() { await client.end(); },
    };
  },
};
const waitTypes = new Set(["Lock", "LWLock", "IO", "IPC", "Client", "Activity", "Timeout", "Extension", "BufferPin"]);
const phaseSet = new Set<string>(requestTestPhases);
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
function requestReport(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const clean = (value: unknown) => {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    if (typeof item.phase !== "string" || !phaseSet.has(item.phase)) return null;
    return {
      phase: item.phase,
      operation: typeof item.operation === "string" && /^\/rest\/v1\/(?:rpc\/)?[a-z][a-z0-9_]{0,62}$/i.test(item.operation) ? item.operation : null,
      sqlState: typeof item.sqlState === "string" && /^[0-9A-Z]{5}$/.test(item.sqlState) ? item.sqlState : null,
      status: Number.isInteger(item.status) && Number(item.status) >= 100 && Number(item.status) <= 599 ? item.status : null,
      elapsedMs: numeric(item.headersMs) ? item.headersMs : null,
    };
  };
  return {
    firstFailure: clean(record.firstFailure),
    requests: Array.isArray(record.observations) ? record.observations.slice(-32).map(clean).filter(Boolean) : [],
    stageFailures: Array.isArray(record.stageFailures) ? record.stageFailures.slice(-16).map(clean).filter(Boolean) : [],
    phases: Array.isArray(record.phases) ? record.phases.slice(-64).flatMap(item => item && phaseSet.has(item.phase) && numeric(item.elapsedMs) ? [{ phase: item.phase, elapsedMs: item.elapsedMs }] : []) : [],
  };
}

type LifecycleCase = {
  name: string;
  module: { moduleId: string };
  project: { config: { root: string }; getProvidedContext(): { supabaseUrl: string; databaseUrl: string } };
  logs(): readonly Pick<UserConsoleLog, "content">[];
};
/** Opt-in runner fixture. Does not change test selection, clocks or errors. */
export default class OperationalBulkCapture implements Reporter {
  private seen = false;
  private active = false;
  private root = "";
  private started = 0;
  private interval?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private pending = Promise.resolve();
  private connection?: Connection;
  private stopLogs?: () => void;
  private reader?: ReturnType<typeof createPostgresFrameReader>;
  private stopping?: Promise<void>;
  private bytes = 0;
  private truncated = false;
  private requestCaptured = false;
  private logUnavailable = false;
  private sampleUnavailable = false;
  private readonly exit = () => {
    this.active = false; clearInterval(this.interval); clearTimeout(this.deadline);
    try { this.stopLogs?.(); } catch { this.logUnavailable = true; }
    void this.connection?.close().catch(() => {});
    if (this.root) this.write("capture.jsonl", { reason: "runner_exit", elapsedMs: performance.now() - this.started, requestCaptured: this.requestCaptured, logUnavailable: this.logUnavailable, sampleUnavailable: this.sampleUnavailable, truncated: this.truncated });
  };
  constructor(private readonly io: CaptureTransport = transport, private readonly environment: Record<string, string | undefined> = process.env) {}
  private matches(test: LifecycleCase) {
    return test.name === operationalBulkCase && path.relative(test.project.config.root, test.module.moduleId).split(path.sep).join("/") === "tests/operational-email-alerts.test.ts";
  }
  private write(file: "postgres.jsonl" | "waits.jsonl" | "request.jsonl" | "capture.jsonl", value: object) {
    try {
      const line = JSON.stringify(value) + "\n";
      if (this.bytes + line.length > 1048576 && file !== "capture.jsonl") { this.truncated = true; return; }
      this.bytes += line.length;
      const target = path.join(this.root, "test-results", "operational-bulk-capture", file);
      fs.appendFileSync(target, line, { mode: 0o600 }); fs.chmodSync(target, 0o600);
    } catch { /* Filesystem errors never replace the application's result. */ }
  }
  async onTestCaseReady(test: LifecycleCase) {
    if (this.environment.IVAT_OPERATIONAL_BULK_CAPTURE !== "1" || this.seen || !this.matches(test)) return;
    this.seen = true;
    this.started = performance.now();
    try {
      const root = fs.realpathSync(test.project.config.root);
      const context = this.io.context(root);
      const config = this.io.config(path.join(context.isLinkedWorktree ? context.generatedWorkdir : root, "supabase", "config.toml"));
      const provided = test.project.getProvidedContext();
      const selected = validateCaptureContext({ linked: context.isLinkedWorktree, root, workspace: this.environment.GITHUB_WORKSPACE ? fs.realpathSync(this.environment.GITHUB_WORKSPACE) : "", environment: this.environment, config, provided });
      const ports = await this.io.inspect(selected.container) as Record<string, { HostPort: string }[]>;
      if (!ports["5432/tcp"]?.some(port => port.HostPort === selected.databasePort)) throw unavailable();
      const results = path.join(root, "test-results");
      if (fs.existsSync(results) && fs.lstatSync(results).isSymbolicLink()) throw unavailable();
      const directory = path.join(results, "operational-bulk-capture");
      if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw unavailable();
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(directory) !== directory) throw unavailable();
      const files = ["capture.jsonl", "request.jsonl", "postgres.jsonl", "waits.jsonl"].map(file => path.join(directory, file));
      if (files.some(file => fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()))) throw unavailable();
      for (const file of files) { fs.writeFileSync(file, "", { mode: 0o600 }); fs.chmodSync(file, 0o600); }
      this.root = root; this.active = true;
      this.deadline = setTimeout(() => { void this.stop("120s_cap"); }, Math.max(0, 120000 - (performance.now() - this.started)));
      this.reader = createPostgresFrameReader(frame => this.write("postgres.jsonl", { elapsedMs: performance.now() - this.started, ...frame }));
      this.stopLogs = this.io.logs(selected.container, new Date().toISOString(), chunk => { if (this.active) this.reader?.accept(chunk); }, () => { this.logUnavailable = true; });
      this.connection = await this.io.connect(selected.databaseUrl);
      if (!this.active) { await this.connection.close(); this.connection = undefined; return; }
      this.interval = setInterval(() => {
        if (!this.active) return;
        // One query in flight; timer ticks never build a backlog.
        const connection = this.connection;
        if (!connection) return;
        this.connection = undefined;
        this.pending = connection.sample().then(rows => {
          if (this.active) this.write("waits.jsonl", { elapsedMs: performance.now() - this.started, waits: rows.slice(0, 32).map(row => ({ waitType: typeof row.wait_event_type === "string" && waitTypes.has(row.wait_event_type) ? row.wait_event_type : null, blockerCount: Number.isInteger(row.blocker_count) && Number(row.blocker_count) >= 0 ? row.blocker_count : null })) });
        }).catch(() => { this.sampleUnavailable = true; }).finally(() => { this.connection = connection; });
      }, 100);
      process.once("exit", this.exit);
    } catch {
      this.logUnavailable = true; this.sampleUnavailable = true;
      await this.stop("capture_unavailable");
      if (!this.root) console.info("Operational bulk capture unavailable: context validation failed");
    }
  }
  onUserConsoleLog(log: Pick<UserConsoleLog, "content">) {
    if (!this.active || this.requestCaptured || log.content.length > 65536) return;
    for (const line of log.content.split("\n")) {
      const match = line.match(/^Supabase request (?:failure diagnostics|measurement) [^\n]*?: (\{.*\})$/);
      if (!match) continue;
      try { const report = requestReport(JSON.parse(match[1])); if (report) { this.write("request.jsonl", report); this.requestCaptured = true; } } catch { /* No raw/unparsed content is retained. */ }
    }
  }
  async onTestCaseResult(test: LifecycleCase) {
    if (!this.matches(test)) return;
    for (const log of test.logs()) this.onUserConsoleLog(log);
    await this.stop("target_finished");
  }
  async onTestRunEnd() { await this.stop("run_finished"); }
  async onProcessTimeout() { await this.stop("runner_exit"); }
  private async stop(reason: string) {
    if (this.stopping) return this.stopping;
    this.active = false; clearInterval(this.interval); clearTimeout(this.deadline);
    try { this.stopLogs?.(); } catch { this.logUnavailable = true; }
    this.stopping = (async () => {
      await this.pending;
      await this.connection?.close().catch(() => { this.sampleUnavailable = true; });
      this.reader?.finish(); process.removeListener("exit", this.exit);
      if (this.root) this.write("capture.jsonl", { reason, elapsedMs: performance.now() - this.started, requestCaptured: this.requestCaptured, logUnavailable: this.logUnavailable, sampleUnavailable: this.sampleUnavailable, truncated: this.truncated });
    })();
    return this.stopping;
  }
}
