import { getTranslations } from "next-intl/server";
import { exportReportingPeriodWorkbook } from "@/application/reporting-period-excel";
import { downloadResponse, refusalResponse } from "@/lib/route-responses";
import { requireUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: RouteContext<"/companies/[companyId]/vat-reports/[period]/xlsx">,
) {
  const { companyId, period } = await context.params;
  const [workbook, reporting] = await Promise.all([
    getTranslations("reportingWorkbook"), getTranslations("documentReporting"),
  ]);
  const [result, t] = await Promise.all([
    exportReportingPeriodWorkbook(await requireUserClient(), { companyId, period }, {
      columns: workbook.raw("columns"), sheets: workbook.raw("sheets"),
      fileNamePrefix: workbook("fileNamePrefix"), inclusion: workbook.raw("inclusion"), mapping: workbook.raw("mapping"),
      reasons: reporting.raw("reasons"), details: reporting.raw("details"), unknownReasons: reporting.raw("unknownReasons"),
    }),
    getTranslations("errors"),
  ]);
  if (!result.ok) {
    return refusalResponse(result.error, { message: t(result.error) });
  }
  return downloadResponse(result.value);
}
