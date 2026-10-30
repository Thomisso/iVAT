import { beginUploadBatch } from "@/application/upload-batches";
import { isUuid } from "@/application/client";
import { requireUserClient } from "@/lib/supabase/server";

export async function POST(
  request: Request,
  ctx: RouteContext<"/companies/[companyId]/upload-batches">,
) {
  const { companyId } = await ctx.params;
  const body = (await request.json().catch(() => null)) as {
    fileCount?: unknown;
    batchId?: unknown;
    selectedFiles?: unknown;
  } | null;
  if (!Number.isInteger(body?.fileCount) || Number(body?.fileCount) < 1) {
    return Response.json(
      { ok: false, error: "file_required" },
      { status: 400 },
    );
  }
  if (typeof body?.batchId !== "string" || !isUuid(body.batchId)
    || !Array.isArray(body.selectedFiles)
    || body.selectedFiles.some((file) => !file || typeof file.id !== "string" || !isUuid(file.id)
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256))) {
    return Response.json({ ok: false, error: "invalid_choice" }, { status: 400 });
  }
  const result = await beginUploadBatch(await requireUserClient(), {
    companyId,
    fileCount: Number(body?.fileCount),
    batchId: body.batchId,
    selectedFiles: body.selectedFiles,
  });
  if (!result.ok) {
    return Response.json(result, {
      status: result.error === "forbidden" ? 403 : 400,
    });
  }
  return Response.json(result, { status: 201 });
}
