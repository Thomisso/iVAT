import { readDocumentPages } from "@/application/documents";
import { requireUserClient } from "@/lib/supabase/server";

// Serves the Document's own pages for the review workspace, as the signed-in user.
export async function GET(request: Request, ctx: RouteContext<"/companies/[companyId]/documents/[documentId]/content">) {
  const { companyId, documentId } = await ctx.params;
  const requested = new URL(request.url).searchParams.get("version");
  const pages = await readDocumentPages(await requireUserClient(), companyId, documentId, requested === null ? undefined : Number(requested));
  if (!pages) return new Response(null, { status: 404 });

  return new Response(Buffer.from(pages.bytes), {
    headers: {
      "Content-Type": pages.mediaType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(pages.fileName)}`,
      "Cache-Control": "private, max-age=3600, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
