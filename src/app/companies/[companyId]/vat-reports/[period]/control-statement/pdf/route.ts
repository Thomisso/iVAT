import { getTranslations } from "next-intl/server";
import { exportControlStatementPdf } from "@/application/control-statement-pdf";
import { downloadResponse, refusalResponse } from "@/lib/route-responses";
import { requireUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: RouteContext<
    "/companies/[companyId]/vat-reports/[period]/control-statement/pdf"
  >,
) {
  const { companyId, period } = await context.params;
  const result = await exportControlStatementPdf(await requireUserClient(), {
    companyId,
    period,
  });
  if (!result.ok) {
    const t = await getTranslations("errors");
    return refusalResponse(result.error, {
      status: 404,
      message: t(result.error),
    });
  }
  return downloadResponse(result.value);
}
