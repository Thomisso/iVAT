import { exportCompanyData } from "@/application/company-deletion";
import { requireUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: RouteContext<"/companies/[companyId]/export">,
) {
  const { companyId } = await context.params;
  const result = await exportCompanyData(await requireUserClient(), {
    companyId,
  });
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (!result.ok) {
    return Response.json(
      { error: result.error },
      {
        status: result.error === "forbidden" ? 404 : 422,
        headers,
      },
    );
  }
  return new Response(Buffer.from(result.value.bytes), {
    headers: {
      ...headers,
      "Content-Type": result.value.mediaType,
      "Content-Disposition": `attachment; filename="${result.value.fileName}"`,
      "X-Company-Export-Id": result.value.exportId,
    },
  });
}
