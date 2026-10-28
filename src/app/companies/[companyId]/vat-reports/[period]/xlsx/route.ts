import { getTranslations } from "next-intl/server";
import { exportReportingPeriodWorkbook } from "@/application/reporting-period-excel";
import { requireUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: RouteContext<"/companies/[companyId]/vat-reports/[period]/xlsx">,
) {
  const { companyId, period } = await context.params;
  const [result, t] = await Promise.all([
    exportReportingPeriodWorkbook(await requireUserClient(), { companyId, period }),
    getTranslations("errors"),
  ]);
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (!result.ok) {
    return Response.json(
      { error: result.error, message: t(result.error) },
      { status: result.error === "forbidden" ? 404 : 422, headers },
    );
  }
  return new Response(Buffer.from(result.value.bytes), {
    headers: {
      ...headers,
      "Content-Type": result.value.mediaType,
      "Content-Disposition": `attachment; filename="${result.value.fileName}"`,
    },
  });
}
