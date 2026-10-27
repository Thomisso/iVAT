import { finishUploadBatch } from "@/application/upload-batches";
import { requireUserClient } from "@/lib/supabase/server";

export async function POST(
  _request: Request,
  ctx: RouteContext<
    "/companies/[companyId]/upload-batches/[batchId]/finish"
  >,
) {
  const { batchId } = await ctx.params;
  const result = await finishUploadBatch(await requireUserClient(), batchId);
  if (!result.ok) return Response.json(result, { status: 403 });
  return Response.json(result);
}
