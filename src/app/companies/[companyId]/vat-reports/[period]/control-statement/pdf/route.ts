import { getTranslations } from "next-intl/server";
import { exportControlStatementPdf } from "@/application/control-statement-pdf";
import { downloadResponse, refusalResponse } from "@/lib/route-responses";
import { requireUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function download(request: Request, context: RouteContext<"/companies/[companyId]/vat-reports/[period]/control-statement/pdf">) {
  const { companyId, period } = await context.params;
  let details: Record<string, string> = {};
  if (request.method === "POST") {
    try {
      details = Object.fromEntries([...(await request.formData())].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch {
      return refusalResponse("invalid_export_details", { status: 400 });
    }
  }
  const result = await exportControlStatementPdf(await requireUserClient(), { companyId, period, details }, undefined);
  if (!result.ok) {
    const t = await getTranslations("errors");
    return refusalResponse(result.error, { status: 404, message: t(result.error) });
  }
  return downloadResponse(result.value);
}
export const GET = download;
export const POST = download;
