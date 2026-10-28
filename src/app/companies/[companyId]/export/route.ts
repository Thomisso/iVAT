import { exportCompanyData } from "@/application/company-deletion";
import { downloadResponse, refusalResponse } from "@/lib/route-responses";
import { requireUserClient } from "@/lib/supabase/server";
import { createSystemClient } from "@/lib/supabase/system";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: RouteContext<"/companies/[companyId]/export">,
) {
  const { companyId } = await context.params;
  const result = await exportCompanyData(await requireUserClient(), createSystemClient(), {
    companyId,
  });
  if (!result.ok) {
    return refusalResponse(result.error);
  }
  return downloadResponse(result.value, { "X-Company-Export-Id": result.value.exportId });
}
