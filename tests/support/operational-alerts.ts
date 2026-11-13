import { Client } from "pg";
import { inject } from "vitest";
import type { AppClient } from "@/application/client";

/** Auth state not writable by an ordinary User, for revocation verification only. */
export async function alertAccountFixture(userId: string, state: "unverified" | "email_change") {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    if (state === "unverified") await database.query("update auth.users set email_confirmed_at = null where id = $1", [userId]);
    else await database.query("update auth.users set email_change = 'pending@example.test' where id = $1", [userId]);
  } finally { await database.end(); }
}

/** Uses the actual current generation, like a running processing handler. */
export async function documentAlertRequest(documentId: string) {
  const { systemClient } = await import("./worker");
  const result = await systemClient().from("document").select("extraction_request_id").eq("id", documentId).single();
  if (result.error) throw result.error;
  return result.data.extraction_request_id;
}

/** Current assignment identity for genuine worker issue setup; never reads a credential. */
export async function companyAlertConfigurationFixture(companyId: string): Promise<string> {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    const result = await database.query<{ configuration_id: string }>("select configuration_id from public.company_ai_configuration where company_id=$1", [companyId]);
    if (!result.rows[0]) throw new Error("Missing fixture assignment");
    return result.rows[0].configuration_id;
  } finally { await database.end(); }
}

/** Holds real authenticated public commands open on separate connections so
 * concurrent commits are deterministic. Claims come from the real Auth session;
 * only transaction timing bypasses PostgREST's one-request transaction wrapper. */
export async function manualReviewTransactionFixture(client: AppClient) {
  const session = await client.auth.getSession();
  if (!session.data.session) throw new Error("Missing real fixture session");
  const claims = JSON.parse(Buffer.from(session.data.session.access_token.split(".")[1], "base64url").toString());
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  await database.query("begin");
  await database.query("set local role authenticated");
  await database.query("set local statement_timeout='8s'");
  await database.query("set local lock_timeout='8s'");
  await database.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  return {
    review: (documentId: string) => database.query("select public.start_manual_document_review($1)", [documentId]),
    commit: () => database.query("commit"),
    async close() { try { await database.query("rollback"); } finally { await database.end(); } },
  };
}

/** Prior synthetic tenants are intentionally retained, like a long-running
 * application suite. Only population setup bypasses the Application; the active
 * blockage and its resolution use the real worker and user commands. */
export async function withUnrelatedOperationalIncident(run: () => Promise<void>) {
  const { companyWithWaitingDocuments, removeAiConfigurationFixture } = await import("./fixtures");
  const { startManualDocumentReview, listCompanyDocuments } = await import("@/application/documents");
  const { runOperationalAlertTick } = await import("@/application/operational-alert-worker");
  const { systemClient } = await import("./worker");
  const company = await companyWithWaitingDocuments(1);
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query(`
      with companies as (
        insert into public.company
        select (jsonb_populate_record(null::public.company, to_jsonb(template) ||
          jsonb_build_object('id', gen_random_uuid(), 'ico', (70000000 + n)::text,
            'vat_id', 'CZ' || (70000000 + n)::text, 'name', 'Prior synthetic Company ' || n))).*
        from public.company template cross join generate_series(1, 1100) n
        where template.id = $1
        returning id, organization_id
      )
      insert into public.document (organization_id, company_id, status, has_document_image)
      select organization_id, id, 'needs_review', false from companies cross join generate_series(1, 5)
    `, [company.companyId]);
  } finally { await database.end(); }
  await removeAiConfigurationFixture(company.client, company.companyId);
  await runOperationalAlertTick(systemClient(), {
    mailer: { async send() { return "accepted"; } },
    now: new Date().toISOString(), appOrigin: "https://ivat.example.test",
  });
  try { await run(); }
  finally {
    for (const document of await listCompanyDocuments(company.client, company.companyId)) {
      const result = await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
      if (!result.ok) throw new Error(result.error);
    }
  }
}
