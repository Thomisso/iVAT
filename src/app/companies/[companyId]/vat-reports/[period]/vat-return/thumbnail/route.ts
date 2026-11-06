import { exportVatReturnThumbnail } from "@/application/vat-return-pdf";
import { downloadResponse, refusalResponse } from "@/lib/route-responses";
import { requireUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
async function thumbnail(request: Request, context: RouteContext<"/companies/[companyId]/vat-reports/[period]/vat-return/thumbnail">) {
  const { companyId, period } = await context.params;
  let details: Record<string, string> = {};
  if (request.method === "POST") {
    try {
      details = Object.fromEntries([...(await request.formData())].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch { return refusalResponse("invalid_export_details", { status: 400 }); }
  }
  const result = await exportVatReturnThumbnail(await requireUserClient(), { companyId, period, details });
  if (!result.ok) return refusalResponse(result.error, { status: 404 });
  return downloadResponse(result.value);
}
export const GET = thumbnail;
export const POST = thumbnail;
