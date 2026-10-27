import { getTranslations } from "next-intl/server";
import { exportVatReport } from "@/application/epo-export";
import { requireUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: RouteContext<"/companies/[companyId]/vat-reports/[period]/xml">,
) {
  const { companyId, period } = await context.params;
  const client = await requireUserClient();
  const t = await getTranslations("errors");
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "invalid_export_details", message: t("invalid_export_details") },
      { status: 400, headers },
    );
  }
  const details = Object.fromEntries(
    [...form].flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  );
  const result = await exportVatReport(client, {
    companyId,
    period,
    format: details.format ?? "",
    details,
  });
  if (!result.ok)
    return Response.json(
      { error: result.error, message: t(result.error) },
      { status: result.error === "report_not_found" ? 404 : 422, headers },
    );
  return new Response(result.value.xml, {
    headers: {
      ...headers,
      "Content-Type": result.value.mediaType,
      "Content-Disposition": `attachment; filename="${result.value.fileName}"`,
    },
  });
}
