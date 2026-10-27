import { beginUploadBatch } from "@/application/upload-batches";
import { requireUserClient } from "@/lib/supabase/server";

export async function POST(
  request: Request,
  ctx: RouteContext<"/companies/[companyId]/upload-batches">,
) {
  const { companyId } = await ctx.params;
  const body = (await request.json().catch(() => null)) as {
    fileCount?: unknown;
  } | null;
  if (!Number.isInteger(body?.fileCount) || Number(body?.fileCount) < 1) {
    return Response.json(
      { ok: false, error: "file_required" },
      { status: 400 },
    );
  }
  const result = await beginUploadBatch(await requireUserClient(), {
    companyId,
    fileCount: Number(body?.fileCount),
  });
  if (!result.ok) {
    return Response.json(result, {
      status: result.error === "forbidden" ? 403 : 400,
    });
  }
  return Response.json(result, { status: 201 });
}
