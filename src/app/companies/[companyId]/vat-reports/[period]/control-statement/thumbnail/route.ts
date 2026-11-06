import { exportControlStatementThumbnail } from "@/application/control-statement-pdf";
import { downloadResponse, refusalResponse } from "@/lib/route-responses";
import { requireUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function thumbnail(request: Request, context: RouteContext<"/companies/[companyId]/vat-reports/[period]/control-statement/thumbnail">) {
  const { companyId, period } = await context.params;
  let details: Record<string, string> = {};
  if (request.method === "POST") {
    try {
      details = Object.fromEntries([...(await request.formData())].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch {
      return refusalResponse("invalid_export_details", { status: 400 });
    }
  }
  const result = await exportControlStatementThumbnail(await requireUserClient(), { companyId, period, details });
  return result.ok ? downloadResponse(result.value) : refusalResponse(result.error, { status: 404 });
}
export const GET = thumbnail;
export const POST = thumbnail;
