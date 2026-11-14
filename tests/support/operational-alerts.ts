import { Client } from "pg";
import { inject } from "vitest";
import type { AppClient } from "@/application/client";
import type { AiProcessingIssueClassification } from "@/application/ai-provider";

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

type ClassifiedIssueFixtureInput = {
  classification: AiProcessingIssueClassification;
  state: "waiting_for_platform" | "terminal";
  configurationId?: string;
};

/** Classified worker starting state at the current request generation; tests
 * exercise subsequent reconciliation, authorization and real remediation. */
export async function classifiedDocumentIssueFixture(documentId: string, input: ClassifiedIssueFixtureInput) {
  const { systemClient } = await import("./worker");
  const result = await systemClient().rpc("record_ai_processing_issue", {
    target_kind: "document", target_id: documentId,
    target_extraction_request_id: await documentAlertRequest(documentId),
    target_classification: input.classification, target_state: input.state,
    target_configuration_id: input.configurationId,
  });
  if (result.error) throw result.error;
}

/** Source counterpart of the generation-bound classified worker setup. */
export async function classifiedSourceIssueFixture(sourceFileId: string, input: ClassifiedIssueFixtureInput) {
  const { systemClient } = await import("./worker");
  const { sourceSplitRequestFixture } = await import("./source-request");
  const system = systemClient();
  const result = await system.rpc("record_ai_processing_issue", {
    target_kind: "source_file", target_id: sourceFileId,
    target_split_request_id: await sourceSplitRequestFixture(system, sourceFileId),
    target_classification: input.classification, target_state: input.state,
    target_configuration_id: input.configurationId,
  });
  if (result.error) throw result.error;
}

/** Prepare a failed receipt through the existing worker transition. */
export async function failedCompanyDataExportFixture(exportId: string) {
  const { systemClient } = await import("./worker");
  const result = await systemClient().rpc("fail_company_data_export", { target_export_id: exportId });
  if (result.error) throw result.error;
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

/** Assigned-but-disabled monitoring setup has no current public creator:
 * assignment enables AI and direct authenticated flag updates are revoked.
 * Reassignment and remediation under test still use their public commands. */
export async function assignedCompanyWithDisabledAiFixture(companyId: string) {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try { await database.query("update public.company set ai_processing_enabled=false where id=$1", [companyId]); }
  finally { await database.end(); }
}

/** Cleanup only: remove a scenario's allowance so it cannot affect later tests. */
export async function clearOperationalAlertAllowanceFixture(companyId: string) {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try { await database.query("update public.company set ai_processing_allowance=null where id=$1", [companyId]); }
  finally { await database.end(); }
}

/** A retained pre-classification/interrupted worker state: the Document was
 * marked Failed before a classified AI issue could be recorded. A current
 * cooperative handler always records that additional issue/root, so this is
 * deliberately legacy queue-alert setup, not claimed current handler proof. */
export async function legacyUnclassifiedFailedDocumentFixture(documentId: string) {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    const result = await database.query(`update public.document set status='failed'
      where id=$1 and status='uploaded' and not exists (select 1 from public.ai_processing_issue where target_kind='document' and target_id=$1)`, [documentId]);
    if (result.rowCount !== 1) throw new Error("Legacy failure fixture requires one unclassified uploaded Document");
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
