import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import type { AppClient } from "@/application/client";
import { localSupabaseContext } from "../../scripts/supabase-status.mjs";
import { validateCaptureContext } from "./operational-bulk-capture";
import { cleanPlan, documentOverviewPageSql, type withDocumentOverviewPlan } from "./document-overview-plan";

type Context = Parameters<typeof withDocumentOverviewPlan>[3];
const unavailable = () => new Error("diagnostic unavailable");
const code = (e: unknown) => e && typeof e === "object" && "code" in e && typeof e.code === "string" && /^[A-Z0-9]{5}$/.test(e.code) ? e.code : null;
const fields = ["jit", "jit_above_cost", "jit_inline_above_cost", "jit_optimize_above_cost", "plan_cache_mode", "work_mem", "effective_cache_size", "random_page_cost", "seq_page_cost", "cpu_tuple_cost", "cpu_index_tuple_cost", "cpu_operator_cost", "max_parallel_workers_per_gather"];
const numeric = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
function frames(error: unknown) {
  if (!error || typeof error !== "object" || !("where" in error) || typeof error.where !== "string") return [];
  return error.where.slice(0, 32768).split("\n").slice(0, 64).flatMap(line => {
    const pl = line.match(/^PL\/pgSQL function ((?:(?:public|private|auth|storage)\.)?[a-z_][a-z0-9_]{0,62})\([^\n]*\) line (\d+)\b/);
    const sql = line.match(/^SQL function "((?:(?:public|private|auth|storage)\.)?[a-z_][a-z0-9_]{0,62})" (?:statement \d+|during inlining)\b/);
    const name = pl?.[1] ?? sql?.[1]; if (!name) return [];
    const parts = name.split("."); const number = pl ? Number(pl[2]) : null;
    if (number !== null && (!Number.isSafeInteger(number) || number < 1)) return [];
    return [{ schema: parts.length === 2 ? parts[0] : null, function: parts.at(-1)!, line: number }];
  });
}
function setting(name: unknown, value: unknown): object[] {
  if (typeof name !== "string" || !fields.includes(name) || typeof value !== "string") return [];
  if (["on", "off"].includes(value)) return [{ name, value: value === "on" }];
  if (name === "plan_cache_mode" && ["auto", "force_custom_plan", "force_generic_plan"].includes(value)) return [{ name, value }];
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|kB|MB|GB)?$/);
  return match ? [{ name, value: Number(match[1]), unit: match[2] ?? null }] : [];
}
function write(root: string, report: object) {
  try {
    const directory = path.join(root, "test-results");
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) return;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "document-overview-failure.json");
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) return;
    const text = JSON.stringify(report);
    fs.writeFileSync(file, text.length <= 262144 ? text + "\n" : '{"truncated":true}\n', { mode: 0o600 }); fs.chmodSync(file, 0o600);
  } catch { /* Even a failed sink cannot replace the public error. */ }
}

/** Failure-only CI observer. Every plan/frame is secondary and source-equivalent;
 * this does not retrieve PostgREST's original wrapper or cached plan. */
export async function collectOverviewFailure(client: AppClient, companyId: string, context: Context) {
  const failure = context.failure;
  const first = failure?.firstFailure() as Record<string, unknown> | null;
  if (!failure || first?.kind !== "request" || first.phase !== "readback_assertions" || first.operation !== "/rest/v1/document_overview" || first.status !== 500 || first.sqlState !== "57014") return;
  const report: Record<string, unknown> = { source: "diagnostic_source_equivalent", originalWrapperCaptured: false, cleanupReserveMs: 4000, plainTimeoutMs: 750, analyzeTimeoutMs: 3000 };
  const bodyDeadline = failure.bodyStartedAt + failure.timeoutMs;
  const cap = Math.min(5000, bodyDeadline - performance.now() - 4000);
  report.captureCapMs = cap;
  if (failure.timeoutMs !== 20000 || !Number.isFinite(cap) || cap < 1000) { report.skipped = "remaining_budget"; write(context.root, report); return; }
  const workDeadline = performance.now() + cap - 250;
  let database: Client | undefined, stopped = false;
  let rejectStop!: (reason: Error) => void;
  const stopPromise = new Promise<never>((_, reject) => { rejectStop = reject; }); void stopPromise.catch(() => {});
  const end = () => database?.end().catch(() => {});
  const stop = () => { stopped = true; report.unavailable = true; rejectStop(unavailable()); void end(); };
  const timer = setTimeout(stop, cap - 250);
  failure.signal.addEventListener("abort", stop, { once: true });
  const wait = async <T>(pending: Promise<T>) => { const result = await Promise.race([pending, stopPromise]); if (stopped) throw unavailable(); return result; };
  const query = (text: string, values?: unknown[]) => wait(database!.query(text, values));
  try {
    if (!failure.ready() || failure.signal.aborted || process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") throw unavailable();
    const root = fs.realpathSync(context.root);
    const local = localSupabaseContext({ cwd: root });
    const config = fs.readFileSync(path.join(local.isLinkedWorktree ? local.generatedWorkdir : context.root, "supabase/config.toml"), "utf8");
    const selected = validateCaptureContext({ linked: local.isLinkedWorktree, root, workspace: process.env.GITHUB_WORKSPACE ? fs.realpathSync(process.env.GITHUB_WORKSPACE) : "", environment: process.env, config, provided: context });
    const apiSection = config.split(/^\[api\]\s*$/m)[1]?.split(/^\[/m)[0];
    if (local.isLinkedWorktree || !/^max_rows\s*=\s*1000\s*$/m.test(apiSection ?? "")) throw unavailable();
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    const session = await wait(Promise.race([client.auth.getSession().then(r => r.data.session), new Promise<never>((_, reject) => { sessionTimer = setTimeout(() => reject(unavailable()), 500); })]).finally(() => clearTimeout(sessionTimer)));
    if (!session || !failure.ready()) throw unavailable();
    const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString());
    if (claims.role !== "authenticated" || claims.sub !== session.user.id || typeof claims.session_id !== "string" || !["aal1", "aal2"].includes(claims.aal)) throw unavailable();
    database = new Client({ connectionString: selected.databaseUrl, connectionTimeoutMillis: 500, query_timeout: 3500, application_name: "ivat-344-failure-plan" });
    database.on("error", () => { report.connectionUnavailable = true; });
    const connecting = database.connect();
    // Stop may precede acquisition. Close again if a late transport resolves.
    void connecting.then(() => { if (stopped) void end(); }, () => {});
    await wait(connecting);
    await query("begin read only"); await query("set local statement_timeout = '500ms'");
    const metadata = (await query(`select current_setting('server_version_num') as server_version_num,version() as server_build,
      pg_jit_available() as jit_available,current_setting('jit_provider') as provider,
      (select setting from pg_config where name='CONFIGURE') as build_config,
      (select jsonb_agg(jsonb_build_object('role',rolname,'settings',rolconfig)) from pg_roles where rolname in ('authenticated','authenticator')) as roles,
      (select jsonb_agg(jsonb_build_object('name',name,'setting',setting)) from pg_settings where name=any($2::text[])) as settings,
      (select jsonb_agg(jsonb_build_object('relation',c.relname,'rows',c.reltuples,'pages',c.relpages,
        'distinctCompanies',(select n_distinct from pg_stats where schemaname='public' and tablename=c.relname and attname='company_id'),
        'mcvCount',(select array_length(most_common_freqs,1) from pg_stats where schemaname='public' and tablename=c.relname and attname='company_id')))
        from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('document','source_file','extraction_version')) as tables,
      (select count(*)::int from public.document where company_id=$1 and superseded_at is null) as documents,
      (select count(*)::int from public.document where company_id=$1 and source_file_id=$3 and superseded_at is null) as bulk_documents,
      (select count(*)::int from public.extraction_version where company_id=$1) as versions`, [companyId, fields, context.sourceFileId ?? null])).rows[0];
    if (!metadata?.roles?.every((role: { settings: string[] }) => role.settings?.includes("statement_timeout=8s") && !role.settings.some(s => s.startsWith("pgrst.db_max_rows=") && s !== "pgrst.db_max_rows=1000")) || metadata.roles.length !== 2) throw unavailable();
    report.metadata = {
      serverVersionNum: /^\d+$/.test(metadata.server_version_num) ? Number(metadata.server_version_num) : null,
      architecture: typeof metadata.server_build === "string" ? metadata.server_build.match(/\b(x86_64|aarch64|arm64)\b/)?.[1] ?? null : null,
      jitAvailable: typeof metadata.jit_available === "boolean" ? metadata.jit_available : null,
      jitProvider: typeof metadata.provider === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(metadata.provider) ? metadata.provider : null,
      withLlvm: typeof metadata.build_config === "string" ? /(?:^|\s|')--with-llvm(?:\s|'|$)/.test(metadata.build_config) : null,
      withoutLlvm: typeof metadata.build_config === "string" ? /(?:^|\s|')--without-llvm(?:\s|'|$)/.test(metadata.build_config) : null,
      settings: Array.isArray(metadata.settings) ? metadata.settings.slice(0, 16).flatMap((s: { name: unknown; setting: unknown }) => setting(s.name, s.setting)) : [],
      tables: Array.isArray(metadata.tables) ? metadata.tables.slice(0, 3).flatMap((t: { relation: string; rows: unknown; pages: unknown; distinctCompanies: unknown; mcvCount: unknown }) => ["document", "source_file", "extraction_version"].includes(t.relation) ? [{ relation: t.relation, rows: numeric(t.rows) ? t.rows : null, pages: numeric(t.pages) ? t.pages : null, distinctCompanies: numeric(t.distinctCompanies) ? t.distinctCompanies : null, mcvCount: numeric(t.mcvCount) ? t.mcvCount : null }] : []) : [],
      documents: numeric(metadata.documents) ? metadata.documents : null, bulkDocuments: context.sourceFileId && numeric(metadata.bulk_documents) ? metadata.bulk_documents : null, versions: numeric(metadata.versions) ? metadata.versions : null,
      nativeStatementTimeoutMs: 8000, apiMaxRows: 1000, metadataRole: "diagnostic",
    };
    await query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await query("set local role authenticated"); await query("set local row_security = on");
    const authority = (await query("select current_user as role,current_setting('row_security') as rls,current_setting('transaction_read_only') as read_only")).rows[0];
    if (authority?.role !== "authenticated" || authority.rls !== "on" || authority.read_only !== "on") throw unavailable();
    const plan = async (analyze: boolean) => {
      await query("savepoint overview_probe"); await query(`set local statement_timeout = '${analyze ? 3000 : 750}ms'`);
      const began = performance.now();
      try {
        if (analyze && (workDeadline - performance.now() < 3000 || bodyDeadline - performance.now() < 7250)) return { skipped: "remaining_budget" };
        const result = await query(`explain (${analyze ? "analyze, buffers, " : ""}settings, format json) ${documentOverviewPageSql}`, [companyId]);
        return { plan: cleanPlan(result.rows[0]?.["QUERY PLAN"]), elapsedMs: performance.now() - began };
      } catch (error) {
        if (!stopped) await query("rollback to savepoint overview_probe");
        return { source: "diagnostic_source_equivalent", sqlState: code(error), frames: frames(error), elapsedMs: performance.now() - began, unavailable: true };
      } finally { if (!stopped) await query("release savepoint overview_probe"); }
    };
    const plain = await plan(false); report.plain = plain;
    if (!plain.unavailable && workDeadline - performance.now() >= 3000 && bodyDeadline - performance.now() >= 7250) report.analyze = await plan(true);
    else report.analyze = { skipped: plain.unavailable ? "plain_unavailable" : "remaining_budget" };
    await query("rollback");
  } catch (error) { report.unavailable = true; report.sqlState = code(error); }
  finally {
    stopped = true; clearTimeout(timer); failure.signal.removeEventListener("abort", stop);
    let closingTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([end(), new Promise<void>(resolve => { closingTimer = setTimeout(resolve, 250); })]); clearTimeout(closingTimer);
    write(context.root, report);
  }
}
