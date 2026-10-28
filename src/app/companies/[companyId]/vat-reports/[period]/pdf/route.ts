import { getTranslations } from "next-intl/server";
import { exportVatReturnPdf } from "@/application/vat-return-pdf";
import { downloadResponse, refusalResponse } from "@/lib/route-responses";
import { requireUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: RouteContext<"/companies/[companyId]/vat-reports/[period]/pdf">,
) {
  const { companyId, period } = await context.params;
  const result = await exportVatReturnPdf(await requireUserClient(), {
    companyId,
    period,
  });
  if (!result.ok) {
    const t = await getTranslations("errors");
    return refusalResponse(result.error, { status: 404, message: t(result.error) });
  }
  return downloadResponse(result.value);
}
