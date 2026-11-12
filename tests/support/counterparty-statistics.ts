import { Client } from "pg";
import { inject } from "vitest";
import type { ExtractionPayload } from "@/application/extraction-payload";

/** Predecessor data can contain expired claims, incomplete amounts or missing
 * dates that today's approval guards reject. Setup is session-local; every
 * assertion reads the public application query under a genuine User identity. */
export async function legacyCounterpartyTradeFixture(
  owner: { companyId: string; organizationId: string; userId: string },
  documents: { payload: ExtractionPayload; previous?: ExtractionPayload; status?: "approved" | "needs_review" | "rejected" | "processing"; superseded?: boolean }[],
) {
  const rows = documents.map(document => ({ ...document, id: crypto.randomUUID() }));
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query("begin");
    await database.query("set local session_replication_role = replica");
    await database.query(`insert into public.document (id, company_id, organization_id, status, has_document_image, superseded_at)
      select (d ->> 'id')::uuid, $2::uuid, $3::uuid, coalesce(d ->> 'status', 'approved')::public.document_status,
        false, case when (d ->> 'superseded')::boolean then now() end
      from jsonb_array_elements($1::jsonb) d`, [JSON.stringify(rows), owner.companyId, owner.organizationId]);
    await database.query(`insert into public.extraction_version
      (document_id, company_id, organization_id, version, author_user_id, payload, counterparty_id, findings)
      select (d ->> 'id')::uuid, $2::uuid, $3::uuid, v.version, $4::uuid, v.payload,
        (v.payload #>> '{counterpartyLink,id}')::uuid, '[]'::jsonb
      from jsonb_array_elements($1::jsonb) d
      cross join lateral (
        select 1 as version, coalesce(d -> 'previous', d -> 'payload') as payload
        union all select 2, d -> 'payload' where d ? 'previous'
      ) v`, [JSON.stringify(rows), owner.companyId, owner.organizationId, owner.userId]);
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally { await database.end(); }
  return rows.map(row => row.id);
}

/** Actual database-boundary outage; the isolated stack restores the grant even
 * after a failed HTTP assertion. No application collaborator is mocked. */
export async function withUnavailableCounterpartyStatistics<T>(operation: () => Promise<T>) {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  const signature = "public.counterparty_statistics(uuid, uuid, date, date, text, text, text, integer)";
  try {
    await database.query(`revoke execute on function ${signature} from authenticated`);
    return await operation();
  } finally {
    try { await database.query(`grant execute on function ${signature} to authenticated`); }
    finally { await database.end(); }
  }
}
