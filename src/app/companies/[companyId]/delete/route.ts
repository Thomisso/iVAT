import { softDeleteCompany } from "@/application/company-deletion";
import { requireUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: RouteContext<"/companies/[companyId]/delete">,
) {
  const { companyId } = await context.params;
  const body = await request.json().catch(() => null) as { exportId?: unknown } | null;
  const result = await softDeleteCompany(await requireUserClient(), {
    companyId,
    exportId: typeof body?.exportId === "string" ? body.exportId : "",
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
  return new Response(null, { status: 204, headers });
}
