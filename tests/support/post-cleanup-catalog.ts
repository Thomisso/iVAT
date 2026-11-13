import type { Client } from "pg";

/** Error codes only; never infer a SQLSTATE from messages or primitive errors. */
export function diagnosticSqlState(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/** Catalog-only boundary on the already owned capture connection. */
export async function readPostCleanupCatalog(database: Pick<Client, "query">, active: () => boolean) {
  const unavailable = () => new Error("catalog unavailable");
  const query = async (sql: string) => {
    if (!active()) throw unavailable();
    const result = await database.query(sql);
    if (!active()) throw unavailable();
    return result;
  };
  await query("begin read only");
  try {
    await query("set local statement_timeout='500ms'");
    const metadata = (await query(`select current_setting('server_version_num') as server_version_num,version() as server_build,
      current_setting('jit') as jit,current_setting('jit_provider') as jit_provider,current_setting('jit_above_cost') as jit_above_cost,
      current_setting('jit_inline_above_cost') as jit_inline_above_cost,current_setting('jit_optimize_above_cost') as jit_optimize_above_cost,
      current_setting('plan_cache_mode') as plan_cache_mode,
      (select count(*)=2 and bool_and(coalesce(rolconfig @> array['statement_timeout=8s'],false) and not exists
        (select 1 from unnest(rolconfig) s where s like 'pgrst.db_max_rows=%' and s<>'pgrst.db_max_rows=1000'))
        from pg_roles where rolname in ('authenticated','authenticator')) as native_role_limits,
      has_function_privilege(current_user,'pg_catalog.pg_jit_available()','execute') as jit_permitted,
      has_table_privilege(current_user,'pg_catalog.pg_stat_all_tables','select') as stats_permitted`)).rows[0];
    let jitAvailability: { available: boolean; value: boolean | null; sqlState: string | null } = { available: false, value: null, sqlState: null };
    if (metadata?.jit_permitted === true) {
      await query("savepoint catalog_jit");
      try {
        const result = (await query("select pg_catalog.pg_jit_available() as available")).rows[0]?.available;
        if (typeof result === "boolean") jitAvailability = { available: true, value: result, sqlState: null };
      } catch (error) {
        jitAvailability.sqlState = diagnosticSqlState(error);
        await query("rollback to savepoint catalog_jit");
      } finally { if (active()) await query("release savepoint catalog_jit"); }
    }
    const statistics: { available: boolean; relations: unknown[]; sqlState: string | null } = { available: false, relations: [], sqlState: null };
    if (metadata?.stats_permitted === true) {
      await query("savepoint catalog_stats");
      try {
        statistics.relations = (await query(`select c.relname as relation,c.reltuples::float8 as rows,c.relpages as pages,
          s.analyze_count::float8 as analyze_count,s.autoanalyze_count::float8 as autoanalyze_count,
          (extract(epoch from (clock_timestamp()-s.last_autoanalyze))*1000)::float8 as last_autoanalyze_age_ms
          from pg_class c join pg_namespace n on n.oid=c.relnamespace
          left join pg_stat_all_tables s on s.relid=c.oid
          where n.nspname='public' and c.relname in ('document','source_file','extraction_version') limit 3`)).rows;
        statistics.available = true;
      } catch (error) {
        statistics.sqlState = diagnosticSqlState(error);
        await query("rollback to savepoint catalog_stats");
      } finally { if (active()) await query("release savepoint catalog_stats"); }
    }
    return { ...metadata, jitAvailability, statistics };
  } finally { if (active()) await query("rollback"); }
}
