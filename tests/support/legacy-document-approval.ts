import { Client as DatabaseClient } from "pg";
import type { ValidationFinding } from "@/application/document-validation";

/** Represents predecessor data approved before complete-data guards existed. */
export async function setLegacyDocumentApprovedFixture(databaseUrl: string, documentId: string, historicalFindings?: ValidationFinding[]) {
  const database = new DatabaseClient({ connectionString: databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    // Session-local fixture setup; no application or other test connection can
    // bypass the guards. Optional findings represent predecessor validation.
    await database.query("set local session_replication_role = replica");
    if (historicalFindings) await database.query(
      "update public.extraction_version set findings = $2::jsonb where id = (select id from public.extraction_version where document_id = $1 order by version desc limit 1)",
      [documentId, JSON.stringify(historicalFindings)],
    );
    await database.query("update public.document set status = 'approved' where id = $1", [documentId]);
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

/** A predecessor draft cached zero blockers before required identity alignment. */
export async function setLegacyReadinessCountFixture(databaseUrl: string, companyId: string, period: string) {
  const database = new DatabaseClient({ connectionString: databaseUrl });
  await database.connect();
  try {
    await database.query("update public.vat_report set blocker_count = 0 where company_id = $1 and period = $2", [companyId, period]);
  } finally {
    await database.end();
  }
}
