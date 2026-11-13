import { Client } from "pg";
import { inject } from "vitest";
import type { AppClient } from "@/application/client";

// Positive table reads here establish only the real server cap precondition;
// business assertions remain in tests through their public Application calls.
export function companyDocumentRowLimitProbe(client: AppClient, companyId: string) {
  return () => client.from("document").select("id").eq("company_id", companyId).limit(10);
}

export function companySourceFileRowLimitProbe(client: AppClient, companyId: string) {
  return () => client.from("source_file").select("id").eq("company_id", companyId).limit(10);
}

export function organizationCompanyRowLimitProbe(client: AppClient, organizationId: string) {
  return () => client.from("company").select("id").eq("organization_id", organizationId);
}

export function sourceUploadChunkRowLimitProbe(client: AppClient, sourceFileId: string) {
  return () => client.from("source_upload_chunk").select("byte_offset").eq("source_file_id", sourceFileId);
}

/** Exercise scalar inventory completeness against a real, smaller response cap.
 * Only use in serial tests; restores this isolated stack's configuration even
 * when assertions fail. Do not run paginated queries under a mismatched cap.
 */
export async function withPostgrestRowLimit<T>(
  limit: number,
  probe: () => PromiseLike<{ data: unknown[] | null; error: unknown }>,
  operation: () => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid fixture row limit");
  const initial = await probe();
  if (initial.error) throw initial.error;
  const initialCount = initial.data!.length;
  if (initialCount <= limit) throw new Error("Fixture must exceed its response cap");
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  const previous = await database.query<{ setting: string }>(
    "select unnest(rolconfig) as setting from pg_roles where rolname = 'authenticator'",
  );
  const setting = previous.rows.find(row => row.setting.startsWith("pgrst.db_max_rows="))?.setting.split("=")[1];
  async function waitForCount(expected: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await probe();
      if (result.error) throw result.error;
      if (result.data?.length === expected) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`PostgREST response cap did not change to ${expected}`);
  }
  try {
    await database.query(`alter role authenticator set pgrst.db_max_rows = '${limit}'`);
    await database.query("notify pgrst, 'reload config'");
    await waitForCount(limit);
    return await operation();
  } finally {
    try {
      if (setting !== undefined) {
        if (!/^\d+$/.test(setting)) throw new Error("Unexpected existing PostgREST row limit");
        await database.query(`alter role authenticator set pgrst.db_max_rows = '${setting}'`);
      } else {
        await database.query("alter role authenticator reset pgrst.db_max_rows");
      }
      await database.query("notify pgrst, 'reload config'");
      await waitForCount(initialCount);
    } finally {
      await database.end();
    }
  }
}
