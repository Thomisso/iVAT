import { getTranslations } from "next-intl/server";
import { exportVatReturnPdf } from "@/application/vat-return-pdf";
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
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (!result.ok) {
    const t = await getTranslations("errors");
    return Response.json(
      { error: result.error, message: t(result.error) },
      { status: 404, headers },
    );
  }
  const bytes = Uint8Array.from(result.value.bytes);
  return new Response(bytes.buffer, {
    headers: {
      ...headers,
      "Content-Type": result.value.mediaType,
      "Content-Disposition": `attachment; filename="${result.value.fileName}"`,
    },
  });
}
