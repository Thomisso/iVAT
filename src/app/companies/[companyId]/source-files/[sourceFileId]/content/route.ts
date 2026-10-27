import { readSourceFile, SOURCE_FILE_MEDIA_TYPES } from "@/application/source-files";
import { requireUserClient } from "@/lib/supabase/server";

// Serves the stored original for the in-app viewer, as the signed-in user.
export async function GET(_request: Request, ctx: RouteContext<"/companies/[companyId]/source-files/[sourceFileId]/content">) {
  const { companyId, sourceFileId } = await ctx.params;
  const stored = await readSourceFile(await requireUserClient(), sourceFileId);
  if (!stored || stored.file.companyId !== companyId) return new Response(null, { status: 404 });

  return new Response(Buffer.from(stored.bytes), {
    headers: {
      "Content-Type": SOURCE_FILE_MEDIA_TYPES[stored.file.format],
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(stored.file.fileName)}`,
      "Cache-Control": "private, max-age=3600, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
