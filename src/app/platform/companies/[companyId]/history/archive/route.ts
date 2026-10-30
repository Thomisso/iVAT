import { downloadPlatformCompanyHistory } from "@/application/platform-company-history";
import { requireUserClient } from "@/lib/supabase/server";

export async function GET(_request: Request, context: RouteContext<"/platform/companies/[companyId]/history/archive">) {
  const { companyId } = await context.params;
  const result = await downloadPlatformCompanyHistory(await requireUserClient(), companyId);
  if (!result.ok) return new Response(null, { status: 404 });
  return new Response(Buffer.from(result.value.bytes), { headers: {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.value.fileName)}`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
}
