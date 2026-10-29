import { readSourceFileDerivative, SOURCE_FILE_MEDIA_TYPES } from "@/application/source-files";
import { requireUserClient } from "@/lib/supabase/server";

/** Serves the normalized browser preview while preserving the separate original. */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/companies/[companyId]/source-files/[sourceFileId]/preview">,
) {
  const { companyId, sourceFileId } = await ctx.params;
  const derivative = await readSourceFileDerivative(
    await requireUserClient(),
    companyId,
    sourceFileId,
  );
  if (!derivative) return new Response(null, { status: 404 });
  return new Response(Buffer.from(derivative.bytes), {
    headers: {
      "Content-Type": SOURCE_FILE_MEDIA_TYPES[derivative.format],
      "Cache-Control": "private, max-age=3600, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
