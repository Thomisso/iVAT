import { getCompanyDataExportStatus } from "@/application/company-deletion";
import { refusalResponse, successfulJsonResponse } from "@/lib/route-responses";
import { requireUserClient } from "@/lib/supabase/server";

export async function GET(
  _request: Request,
  context: RouteContext<"/companies/[companyId]/exports/[exportId]">,
) {
  const { companyId, exportId } = await context.params;
  const result = await getCompanyDataExportStatus(await requireUserClient(), {
    companyId,
    exportId,
  });
  if (!result.ok) return refusalResponse(result.error);
  return successfulJsonResponse(result.value);
}
