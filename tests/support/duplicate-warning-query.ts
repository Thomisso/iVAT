import { Client as DatabaseClient } from "pg";
import { inject } from "vitest";
import type { AppClient } from "@/application/client";

/** Measures the real warning read's authorization work, not its hardware-dependent latency. */
export async function duplicateWarningCompanyAccessChecks(
  client: AppClient,
  companyId: string,
  documentId: string,
): Promise<number> {
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError || !session) throw new Error("Native User session required");
  const { data: { user }, error: userError } = await client.auth.getUser(session.access_token);
  const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString());
  if (userError || !user || user.id !== session.user.id || claims.sub !== user.id
    || claims.role !== "authenticated" || typeof claims.session_id !== "string") {
    throw new Error("Verified native authenticated identity required");
  }

  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query("begin");
    // These settings and counters exist only in this rolled-back transaction.
    // The read uses Auth's verified, unmodified claims and the actual RLS role.
    await database.query("set local statement_timeout = '8s'");
    await database.query("set local track_functions = 'all'");
    await database.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await database.query("set local role authenticated");
    await database.query(
      `explain (analyze, timing off, format json)
       select matched_document_id, kind from public.document_duplicate_warning
       where company_id = $1 and document_id = $2`,
      [companyId, documentId],
    );
    const { rows } = await database.query<{ calls: string }>(
      `select calls from pg_stat_xact_user_functions
       where schemaname = 'private' and funcname = 'can_access_company'`,
    );
    if (rows.length !== 1) throw new Error("Native Company-access measurement missing");
    return Number(rows[0].calls);
  } finally {
    try {
      await database.query("rollback");
    } finally {
      await database.end();
    }
  }
}
