import { Client as DatabaseClient } from "pg";
import { inject } from "vitest";

/** Restored historical evidence naming only one member of a Photo Group. */
export async function lockHistoricalPhotoGroupMemberFixture(input: {
  companyId: string;
  organizationId: string;
  period: string;
  reportId: string;
  userId: string;
  sourceFileId: string;
}): Promise<void> {
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query("update public.vat_report set result=jsonb_set(result,'{sourceFilesReadinessSource}',jsonb_build_array(jsonb_build_object('sourceFileId',$2::text))) where id=$1", [input.reportId, input.sourceFileId]);
    await database.query("insert into public.period_lock(company_id,organization_id,period,vat_report_id,locked_by) values($1,$2,$3,$4,$5)", [input.companyId, input.organizationId, input.period, input.reportId, input.userId]);
  } finally { await database.end(); }
}
