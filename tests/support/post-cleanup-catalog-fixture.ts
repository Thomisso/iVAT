import type { Client } from "pg";
import { readPostCleanupCatalog } from "./post-cleanup-catalog";

/** Controlled PG transport: only the named catalog boundary, never a real DB. */
export function postCleanupCatalogFixture() {
  const calls: string[] = [];
  const failures = new Map<string, Error>();
  let jitPermitted = true, statsPermitted = true;
  const database = { async query(sql: string) {
    const stage = sql.includes("has_function_privilege") ? "metadata"
      : sql.startsWith("select pg_catalog.pg_jit_available") ? "jit"
        : sql.includes("last_autoanalyze_age_ms") ? "statistics"
          : sql.startsWith("rollback to") ? "rollback_optional"
            : sql.startsWith("release") ? "release_optional"
              : sql;
    calls.push(stage);
    if (failures.has(stage)) throw failures.get(stage);
    if (stage === "metadata") return { rows: [{ server_version_num: "170011", jit: "on", jit_permitted: jitPermitted, stats_permitted: statsPermitted }] };
    if (stage === "jit") return { rows: [{ available: true }] };
    if (stage === "statistics") return { rows: [{ relation: "document", rows: -1, pages: 0, analyze_count: 0, autoanalyze_count: 0, last_autoanalyze_age_ms: null }] };
    return { rows: [] };
  } } as Pick<Client, "query">;
  return {
    calls,
    denyJit() { jitPermitted = false; }, denyStatistics() { statsPermitted = false; },
    fail(stage: string, error = Object.assign(new Error("private_metadata_canary"), { code: "42501" })) { failures.set(stage, error); return error; },
    read: () => readPostCleanupCatalog(database, () => true),
  };
}
