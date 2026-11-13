import { Client } from "pg";
import { inject } from "vitest";
import type { ExtractionPayload } from "@/application/extraction-payload";
import type { AppClient } from "@/application/client";
import { systemClient } from "./worker";

/** Historical deleted Company; reads still cross the real User/RLS interface. */
export async function deletedTradeCompanyFixture(owner: { companyId: string; userId: string }) {
  const result = await systemClient().from("company").update({ deleted_at: new Date().toISOString(), deleted_by: owner.userId }).eq("id", owner.companyId);
  if (result.error) throw result.error;
}

/** Rollback-only invalid tenant pairs prove RLS independently of foreign keys.
 * The issued native JWT supplies the same caller identity to the invoker RPC. */
export async function mismatchedTradeTenantFixture(client: AppClient, target: {
  companyId: string; organizationId: string; foreignOrganizationId: string; documentId: string; partyId: string; userId: string;
}, payload: ExtractionPayload) {
  const session = (await client.auth.getSession()).data.session;
  if (!session) throw new Error("Native User session required");
  const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString());
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query("begin");
    await database.query("set local session_replication_role = replica");
    const forgedId = crypto.randomUUID();
    await database.query(`insert into public.document(id, company_id, organization_id, status, has_document_image)
      values($1,$2,$3,'approved',false)`, [forgedId, target.companyId, target.foreignOrganizationId]);
    await database.query(`insert into public.extraction_version(document_id, company_id, organization_id, version, author_user_id, payload, counterparty_id, findings)
      values($1,$2,$3,1,$4,$5,$6,'[]'),($7,$2,$3,99,$4,$5,$6,'[]')`,
    [forgedId, target.companyId, target.foreignOrganizationId, target.userId, payload, target.partyId, target.documentId]);
    await database.query("set local session_replication_role = origin");
    await database.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await database.query("set local role authenticated");
    const document = await database.query("select id from public.document where id=$1", [forgedId]);
    const versions = await database.query("select document_id from public.extraction_version where document_id=$1 or (document_id=$2 and version=99)", [forgedId, target.documentId]);
    const statistics = await database.query("select public.counterparty_statistics($1,$2,'2026-01-01','2026-12-31','','','dated',1) result", [target.companyId, target.partyId]);
    return { document: document.rows, versions: versions.rows, statistics: statistics.rows[0].result };
  } finally {
    await database.query("rollback");
    await database.end();
  }
}

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
