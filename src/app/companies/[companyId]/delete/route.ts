import { softDeleteCompany } from "@/application/company-deletion";
import { refusalResponse, successfulCommandResponse } from "@/lib/route-responses";
import { requireUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: RouteContext<"/companies/[companyId]/delete">,
) {
  const { companyId } = await context.params;
  const body = await request.json().catch(() => null) as { exportId?: unknown } | null;
  const result = await softDeleteCompany(await requireUserClient(), {
    companyId,
    exportId: typeof body?.exportId === "string" ? body.exportId : "",
  });
  if (!result.ok) {
    return refusalResponse(result.error);
  }
  return successfulCommandResponse();
}
