import { Client } from "pg";
import { inject } from "vitest";

/** Negative authorization probe under the actual worker role; never mutates accounting fixtures. */
export async function privateWorkerApprovalRefusals(documentId: string, companyId: string) {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  const errors: string[] = [];
  try {
    for (const query of [
      { sql: "select private.document_counterparty_for_approval($1, $2, '{}'::jsonb, null)", args: [companyId, documentId] },
      { sql: "select private.approve_document_recorded($1, 1)", args: [documentId] },
    ]) {
      await database.query("begin");
      await database.query("set local role service_role");
      await database.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
      try {
        await database.query(query.sql, query.args);
        errors.push("unexpectedly_allowed");
      } catch (error) {
        errors.push((error as { code: string }).code);
      } finally { await database.query("rollback"); }
    }
  } finally { await database.end(); }
  return errors;
}

/** Legacy history fixture with genuinely absent author/version metadata. */
export async function legacyUnknownApprovalFixture(organizationId: string, companyId: string, documentId: string) {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query("insert into public.audit_event(organization_id, company_id, target_type, target_id, action, payload) values($1, $2, 'document', $3, 'document.approved', '{}'::jsonb)",
      [organizationId, companyId, documentId]);
  } finally { await database.end(); }
}
