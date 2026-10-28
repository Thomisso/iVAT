import { exportCompanyData } from "@/application/company-deletion";
import { downloadResponse, refusalResponse } from "@/lib/route-responses";
import { jobQueue } from "@/lib/jobs";
import { requireUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: RouteContext<"/companies/[companyId]/export">,
) {
  const { companyId } = await context.params;
  const result = await exportCompanyData(await requireUserClient(), jobQueue, {
    companyId,
  });
  if (!result.ok) {
    return refusalResponse(result.error);
  }
  return downloadResponse(result.value, { "X-Company-Export-Id": result.value.exportId });
}
