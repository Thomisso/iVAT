import { Client as DatabaseClient } from "pg";

/** Represents an old Approved Version whose missing VAT Regime had no finding. */
export async function addLegacyUndeterminedVatRegimeFixture(databaseUrl: string, documentId: string) {
  const database = new DatabaseClient({ connectionString: databaseUrl });
  await database.connect();
  try {
    await database.query(`insert into public.extraction_version
      (organization_id, company_id, document_id, version, payload, findings, provider, model, extraction_request_id)
      select organization_id, company_id, document_id, version + 1,
        payload || '{"proposedVatRegime":null}'::jsonb, '[]'::jsonb,
        'fake', 'legacy', gen_random_uuid()
      from public.extraction_version where document_id = $1 order by version desc limit 1`, [documentId]);
  } finally {
    await database.end();
  }
}

/** A draft generated before missing VAT Regime became a readiness blocker. */
export async function setLegacyVatRegimeReadinessFixture(databaseUrl: string, companyId: string, period: string) {
  const database = new DatabaseClient({ connectionString: databaseUrl });
  await database.connect();
  try {
    await database.query("update public.vat_report set blocker_count = 0 where company_id = $1 and period = $2", [companyId, period]);
  } finally {
    await database.end();
  }
}
