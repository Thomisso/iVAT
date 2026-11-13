import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";
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

type PgFrame = { sqlState: string | null } | { schema: string | null; function: string; line: number | null };
/** Existing default stderr only; unsupported prefixes/missing codes stay absent.
 * Backend IDs group lines in memory and never leave this parser. */
export function createPostgresFrameReader(emit: (frame: PgFrame) => void) {
  let buffer = "", dropping = false, firstBackend: string | null = null, context = false, closed = false, frames = 0;
  const line = (value: string) => {
    const prefix = value.match(/^\d{4}-\d\d-\d\d[ T][\d:.+-]+(?:\s+[A-Z]+)?\s+\[(\d+)\]\s+(?:\S+@\S+\s+)?(ERROR|CONTEXT|STATEMENT|DETAIL|HINT|LOCATION|LOG|NOTICE|WARNING):\s*(.*)$/);
    let body = value.trim();
    if (prefix) {
      context = false;
      const [, backend, level, text] = prefix;
      if (level === "ERROR" && firstBackend !== null && backend === firstBackend) closed = true;
      if (level === "ERROR" && firstBackend === null && /^(?:[0-9A-Z]{5}:\s+)?canceling statement due to statement timeout\s*$/.test(text)) {
        firstBackend = backend;
        emit({ sqlState: text.match(/^([0-9A-Z]{5}):/)?.[1] ?? null });
      }
      if (closed || level !== "CONTEXT" || backend !== firstBackend) return;
      context = true; body = text;
    }
    if (!context || frames >= 64) return;
    const plpgsql = body.match(/^PL\/pgSQL function ((?:(?:public|private)\.)?[a-z_][a-z0-9_]{0,62})\([^\n]*\) line (\d+)\b/i);
    const match = plpgsql ?? body.match(/^SQL function "((?:(?:public|private)\.)?[a-z_][a-z0-9_]{0,62})" (?:statement \d+|during inlining)\b/i);
    if (match) {
      const sourceLine = plpgsql ? Number(plpgsql[2]) : null;
      if (sourceLine !== null && (!Number.isSafeInteger(sourceLine) || sourceLine < 1)) return;
      const parts = match[1].split("."); frames++;
      // SQL statement ordinals are not source line numbers.
      emit({ schema: parts.length === 2 ? parts[0] : null, function: parts.at(-1)!, line: sourceLine });
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
  logs(container: string, since: string, until: string, accept: (chunk: string) => void, signal?: AbortSignal): Promise<void>;
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
  async logs(container, since, until, accept, signal) {
    if (signal?.aborted) throw new Error("capture log unavailable");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["logs", "--since", since, "--until", until, container], { stdio: ["ignore", "pipe", "pipe"] });
      let ended = false, bytes = 0;
      const complete = (ok: boolean) => {
        if (ended) return; ended = true; clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
        if (!ok) child.kill("SIGKILL");
        if (ok) resolve(); else reject(new Error("capture log unavailable"));
      };
      const deadline = setTimeout(() => complete(false), 2000);
      const abort = () => complete(false);
      signal?.addEventListener("abort", abort, { once: true });
      const receive = (chunk: Buffer) => {
        if (ended) return;
        bytes += chunk.byteLength;
        if (bytes > 8 * 1024 * 1024) { complete(false); return; }
        accept(chunk.toString());
      };
      child.stdout.on("data", receive); child.stderr.on("data", receive);
      child.on("error", () => complete(false));
      child.on("close", code => complete(code === 0));
    });
  },
  async connect(url) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 1000, query_timeout: 1000 });
    let failed = false;
    client.on("error", () => { failed = true; });
    try { await client.connect(); } catch (error) { await client.end().catch(() => {}); throw error; }
    return {
      async sample() { if (failed) throw new Error("capture connection unavailable"); return (await client.query("select wait_event_type,cardinality(pg_blocking_pids(pid))::int as blocker_count from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and backend_type='client backend' and state<>'idle' limit 32")).rows; },
      async close() { await client.end(); if (failed) throw new Error("capture connection unavailable"); },
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
  const firstOverview = record.firstOverviewReadback && typeof record.firstOverviewReadback === "object" ? record.firstOverviewReadback as Record<string, unknown> : null;
  const firstOverviewClean = clean(firstOverview);
  return {
    firstFailure: clean(record.firstFailure),
    firstOverviewReadback: firstOverview?.ordinal === 1 && firstOverviewClean ? { ...firstOverviewClean, ordinal: 1, completed: firstOverview.completed === true } : null,
    requests: Array.isArray(record.observations) ? record.observations.slice(-32).map(clean).filter(Boolean) : [],
    stageFailures: Array.isArray(record.stageFailures) ? record.stageFailures.slice(-16).map(clean).filter(Boolean) : [],
    phases: Array.isArray(record.phases) ? record.phases.slice(-64).flatMap(item => item && phaseSet.has(item.phase) && numeric(item.elapsedMs) ? [{ phase: item.phase, elapsedMs: item.elapsedMs }] : []) : [],
  };
}

export type CaptureCase = { name: string; moduleId: string; root: string; provided: { supabaseUrl: string; databaseUrl: string } };
/** Explicitly awaited by the worker's aroundEach; no reporter notification is a gate. */
export default class OperationalBulkCapture {
  private state: "idle" | "starting" | "active" | "stopped" = "idle";
  private root = "";
  private started = 0;
  private since = "";
  private until = "";
  private container?: string;
  private armed = false;
  private provided?: CaptureCase["provided"];
  private interval?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private startup = Promise.resolve();
  private pending = Promise.resolve();
  private sampling = false;
  private connection?: Connection;
  private stopping?: Promise<void>;
  private bytes = 0;
  private truncated = false;
  private requestCaptured = false;
  private logUnavailable = false;
  private sampleUnavailable = false;
  private readonly logAbort = new AbortController();
  private exiting = false;
  private readonly exit = () => {
    // Only synchronous cleanup belongs in a real process-exit callback. Never
    // acquire a new Docker child while the worker is terminating.
    this.exiting = true; this.state = "stopped"; this.until ||= new Date().toISOString();
    this.logAbort.abort();
    this.logUnavailable = true; clearInterval(this.interval); clearTimeout(this.deadline);
    const close = () => { const connection = this.connection; this.connection = undefined; void connection?.close().catch(() => {}); };
    close(); void this.startup.then(close);
    if (this.root) this.write("capture.jsonl", { reason: "runner_exit", startedAtUtc: this.since, endedAtUtc: this.until, armed: this.armed, requestCaptured: this.requestCaptured, logUnavailable: true });
  };
  constructor(private readonly io: CaptureTransport = transport, private readonly environment: Record<string, string | undefined> = process.env) {}
  private write(file: "postgres.jsonl" | "waits.jsonl" | "request.jsonl" | "capture.jsonl", value: object) {
    try {
      const line = JSON.stringify(value) + "\n";
      if (this.bytes + line.length > 1048576 && file !== "capture.jsonl") { this.truncated = true; return; }
      this.bytes += line.length;
      const target = path.join(this.root, "test-results", "operational-bulk-capture", file);
      fs.appendFileSync(target, line, { mode: 0o600 }); fs.chmodSync(target, 0o600);
    } catch { /* Filesystem errors never replace the application's result. */ }
  }
  async begin(test: CaptureCase) {
    if (this.environment.IVAT_OPERATIONAL_BULK_CAPTURE !== "1" || this.state !== "idle" || test.name !== operationalBulkCase || path.relative(test.root, test.moduleId).split(path.sep).join("/") !== "tests/operational-email-alerts.test.ts") return;
    this.state = "starting"; this.started = performance.now(); this.since = new Date().toISOString();
    this.deadline = setTimeout(() => { void this.end("120s_cap"); }, 120000);
    process.once("exit", this.exit);
    this.startup = this.acquire(test).catch(() => { this.logUnavailable = true; this.sampleUnavailable = true; });
    await this.startup;
    if (this.logUnavailable || this.sampleUnavailable) {
      await this.end("capture_unavailable");
      if (!this.root) console.info("Operational bulk capture unavailable: context validation failed");
    }
  }
  private async acquire(test: CaptureCase) {
    const root = fs.realpathSync(test.root);
    const context = this.io.context(root);
    const config = this.io.config(path.join(context.isLinkedWorktree ? context.generatedWorkdir : root, "supabase", "config.toml"));
    const selected = validateCaptureContext({ linked: context.isLinkedWorktree, root, workspace: this.environment.GITHUB_WORKSPACE ? fs.realpathSync(this.environment.GITHUB_WORKSPACE) : "", environment: this.environment, config, provided: test.provided });
    const ports = await this.io.inspect(selected.container) as Record<string, { HostPort: string }[]>;
    if (this.state !== "starting") return;
    if (!ports["5432/tcp"]?.some(port => port.HostPort === selected.databasePort)) throw unavailable();
    const results = path.join(root, "test-results");
    if (fs.existsSync(results) && fs.lstatSync(results).isSymbolicLink()) throw unavailable();
    const directory = path.join(results, "operational-bulk-capture");
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw unavailable();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(directory) !== directory) throw unavailable();
    fs.chmodSync(directory, 0o700);
    const files = ["capture.jsonl", "request.jsonl", "postgres.jsonl", "waits.jsonl"].map(file => path.join(directory, file));
    if (files.some(file => fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()))) throw unavailable();
    for (const file of files) { fs.writeFileSync(file, "", { mode: 0o600 }); fs.chmodSync(file, 0o600); }
    this.root = root; this.container = selected.container; this.provided = test.provided;
    // This acquisition is owned even if stop arrives before it resolves.
    this.connection = await this.io.connect(selected.databaseUrl);
    if (this.state !== "starting") return;
    this.state = "active"; this.armed = true;
    this.interval = setInterval(() => {
      const connection = this.connection;
      if (this.state !== "active" || this.sampling || !connection) return;
      this.sampling = true;
      this.pending = connection.sample().then(rows => {
        if (this.state === "active") this.write("waits.jsonl", { elapsedMs: performance.now() - this.started, waits: rows.slice(0, 32).map(row => ({ waitType: typeof row.wait_event_type === "string" && waitTypes.has(row.wait_event_type) ? row.wait_event_type : null, blockerCount: Number.isInteger(row.blocker_count) && Number(row.blocker_count) >= 0 ? row.blocker_count : null })) });
      }).catch(() => { this.sampleUnavailable = true; }).finally(() => { this.sampling = false; });
    }, 100);
  }
  hasActiveContext(provided: CaptureCase["provided"]) {
    return this.state === "active" && this.armed && this.provided?.databaseUrl === provided.databaseUrl && this.provided.supabaseUrl === provided.supabaseUrl;
  }
  recordRequestReport(raw: unknown) {
    if (this.requestCaptured || !this.root) return;
    const report = requestReport(raw);
    if (report) { this.write("request.jsonl", report); this.requestCaptured = true; }
  }
  async end(reason = "target_finished") {
    if (this.stopping) return this.stopping;
    this.state = "stopped"; this.until ||= new Date().toISOString();
    clearInterval(this.interval); clearTimeout(this.deadline);
    this.stopping = (async () => {
      await this.startup; await this.pending;
      await this.connection?.close().catch(() => { this.sampleUnavailable = true; }); this.connection = undefined;
      // Bounded historical read, not a new sampling interval: the worker awaits
      // this drain before the next test or CI's disposable DB teardown.
      if (this.armed && this.container && !this.exiting) {
        const reader = createPostgresFrameReader(frame => this.write("postgres.jsonl", frame));
        try { await this.io.logs(this.container, this.since, this.until, chunk => reader.accept(chunk), this.logAbort.signal); }
        catch { this.logUnavailable = true; }
        reader.finish();
      }
      process.removeListener("exit", this.exit);
      if (this.root) this.write("capture.jsonl", { reason, startedAtUtc: this.since, endedAtUtc: this.until, elapsedMs: performance.now() - this.started, armed: this.armed, requestCaptured: this.requestCaptured, logUnavailable: this.logUnavailable, sampleUnavailable: this.sampleUnavailable, truncated: this.truncated });
    })();
    return this.stopping;
  }
}
