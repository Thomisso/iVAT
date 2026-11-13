import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import type { AppClient } from "@/application/client";
import { localSupabaseContext } from "../../scripts/supabase-status.mjs";
import { validateCaptureContext } from "./operational-bulk-capture";

// Source-equivalent to the first listCompanyDocuments page at frozen2004.
// PostgREST's generated aggregation/wrapper is not captured by this plan.
const documentPage = `select id, source_file_id, first_page, last_page, status, created_at,
 version, document_number, direction, tax_point_date, import_date, claimed_reporting_period,
 reporting_period, counterparty_name, counterparty_vat_id, counterparty_ico, currency,
 gross_amount, finding_count, proposed_vat_regime, extraction_version_id, reporting_payload,
 reporting_findings from public.document_overview where company_id=$1
 order by created_at desc, first_page asc, id asc limit 1000 offset 0`;
type Context = { root: string; databaseUrl: string; supabaseUrl: string };
type Safe = null | string | number | boolean | Safe[] | { [key: string]: Safe };
const numericFields = new Set(["Startup Cost", "Total Cost", "Plan Rows", "Plan Width", "Actual Startup Time", "Actual Total Time", "Actual Rows", "Actual Loops", "Rows Removed by Filter", "Rows Removed by Join Filter", "Shared Hit Blocks", "Shared Read Blocks", "Shared Dirtied Blocks", "Shared Written Blocks", "Local Hit Blocks", "Local Read Blocks", "Temp Read Blocks", "Temp Written Blocks", "I/O Read Time", "I/O Write Time", "Sort Space Used", "Planning Time", "Execution Time", "Workers Planned", "Workers Launched", "Functions", "Generation", "Inlining", "Optimization", "Emission", "Total"]);
const nameFields = new Set(["Schema", "Relation Name", "Index Name", "Function Name"]);
const categoryFields = new Set(["Node Type", "Join Type", "Scan Direction", "Sort Method", "Sort Space Type", "Strategy", "Partial Mode", "Parent Relationship"]);
function cleanPlan(value: unknown, depth = 0): Safe {
  if (depth > 32) return null;
  if (Array.isArray(value)) return value.slice(0, 128).map(item => cleanPlan(item, depth + 1));
  if (!value || typeof value !== "object") return null;
  const safe: { [key: string]: Safe } = {};
  for (const [key, item] of Object.entries(value)) {
    if (numericFields.has(key) && typeof item === "number" && Number.isFinite(item) && item >= 0) safe[key] = item;
    else if (nameFields.has(key) && typeof item === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(item)) safe[key] = item;
    else if (categoryFields.has(key) && typeof item === "string" && /^[A-Za-z][A-Za-z -]{0,63}$/.test(item)) safe[key] = item;
    else if (["Plan", "Plans", "JIT", "Timing"].includes(key)) safe[key] = cleanPlan(item, depth + 1);
  }
  return safe;
}
const sqlState = (error: unknown) => error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;

async function collect(client: AppClient, companyId: string, failed: boolean, readMs: number, context: Context) {
  const report: Record<string, Safe> = { publicRead: failed ? "failed" : "succeeded", publicReadMs: readMs, plainTimeoutMs: 750, analyzeTimeoutMs: 3000, sourceEquivalentOnly: true };
  let database: Client | undefined, closing: Promise<void> | undefined, stopped = false;
  const close = () => closing ??= database?.end().catch(() => {}) ?? Promise.resolve();
  const deadline = setTimeout(() => { stopped = true; report.unavailable = true; void close(); }, 5000);
  try {
    const local = localSupabaseContext({ cwd: context.root });
    const selected = validateCaptureContext({ linked: local.isLinkedWorktree, root: context.root, workspace: "", environment: process.env,
      config: fs.readFileSync(path.join(local.generatedWorkdir, "supabase/config.toml"), "utf8"), provided: context });
    if (selected.container !== "supabase_db_ivat-wt79" || selected.databasePort !== "62222" || !local.isLinkedWorktree) throw new Error("unavailable");
    let sessionDeadline: ReturnType<typeof setTimeout> | undefined;
    const session = await Promise.race([
      client.auth.getSession().then(result => result.data.session),
      new Promise<never>((_, reject) => { sessionDeadline = setTimeout(() => reject(new Error("unavailable")), 500); }),
    ]).finally(() => clearTimeout(sessionDeadline));
    if (stopped || !session) throw new Error("unavailable");
    const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString());
    if (claims.role !== "authenticated" || claims.sub !== session.user.id) throw new Error("unavailable");
    database = new Client({ connectionString: selected.databaseUrl, connectionTimeoutMillis: 750, query_timeout: 3500, application_name: "ivat-344-view-plan" });
    database.on("error", () => { report.unavailable = true; });
    await database.connect();
    if (stopped) throw new Error("unavailable");
    await database.query("begin read only");
    await database.query("set local statement_timeout = '750ms'");
    const roles = await database.query("select rolname,rolconfig from pg_roles where rolname in ('authenticated','authenticator')");
    report.nativeSettings = roles.rows.flatMap(row => (row.rolconfig ?? []).flatMap((setting: string) => {
      const match = setting.match(/^(statement_timeout|pgrst.db_max_rows)=(\d+(?:ms|s)?)$/);
      return match ? [{ role: row.rolname as string, setting: match[1], value: match[2] }] : [];
    }));
    await database.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await database.query("set local role authenticated");
    await database.query("set local row_security = on");
    const settings = (await database.query("select current_user as role,current_setting('row_security') as rls,current_setting('statement_timeout') as timeout,current_setting('transaction_read_only') as read_only")).rows[0];
    if (settings.role !== "authenticated" || settings.rls !== "on" || settings.read_only !== "on") throw new Error("unavailable");
    report.authenticated = true; report.rls = true; report.readOnly = true;
    const plan = async (analyze: boolean): Promise<Record<string, Safe>> => {
      const began = performance.now();
      try {
        const result = await database!.query(`explain (${analyze ? "analyze, buffers, " : ""}format json) ${documentPage}`, [companyId]);
        return { plan: cleanPlan(result.rows[0]?.["QUERY PLAN"]), elapsedMs: performance.now() - began };
      } catch (error) { return { sqlState: sqlState(error), elapsedMs: performance.now() - began, unavailable: true }; }
    };
    report.plain = await plan(false);
    // Failed public reads already consumed ~8s. Never add an ANALYZE there.
    if (failed) report.analyze = { reason: "public_read_failed" };
    else if (readMs < 2000 && !(report.plain as Record<string, Safe>).unavailable && !stopped) {
      await database.query("set local statement_timeout = '3000ms'");
      report.analyze = await plan(true);
    } else report.analyze = { reason: "remaining_budget_or_plain_unavailable" };
  } catch (error) { report.unavailable = true; report.sqlState = sqlState(error); }
  finally {
    try { if (database && !closing) await database.query("rollback"); } catch { report.rollbackUnavailable = true; }
    await close(); clearTimeout(deadline);
    try {
      const directory = path.join(context.root, "test-results");
      if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) return;
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const target = path.join(directory, "document-overview-plan.json");
      if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) return;
      fs.writeFileSync(target, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); fs.chmodSync(target, 0o600);
    } catch { /* Diagnostics never replace the original public outcome. */ }
  }
}

/** Opt-in diagnostic observation AFTER the genuine public read, before finally.
 * A failure still propagates as the identical object after bounded collection. */
export async function withDocumentOverviewPlan<T>(client: AppClient, companyId: string, read: () => Promise<T>, context: Context): Promise<T> {
  const started = performance.now();
  let failed = false;
  try { return await read(); }
  catch (error) { failed = true; throw error; }
  finally {
    if (process.env.IVAT_DOCUMENT_OVERVIEW_PLAN === "1") {
      try { await collect(client, companyId, failed, performance.now() - started, context); }
      catch { /* Never replace a successful value or the first error. */ }
    }
  }
}
