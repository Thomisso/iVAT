import { uploadSourceFile } from "@/application/source-files";
import { jobQueue } from "@/lib/jobs";
import { requireUserClient } from "@/lib/supabase/server";

/** One request per file lets the browser report real upload progress for every selected Source File. */
export async function POST(
  request: Request,
  ctx: RouteContext<"/companies/[companyId]/source-files">,
) {
  const { companyId } = await ctx.params;
  const formData = await request.formData();
  const file = formData.get("file");
  const result = await uploadSourceFile(await requireUserClient(), jobQueue, {
    companyId,
    sourceFileId: String(formData.get("sourceFileId") ?? ""),
    batchId: String(formData.get("batchId") ?? ""),
    fileName: file instanceof File ? file.name : "",
    bytes:
      file instanceof File
        ? new Uint8Array(await file.arrayBuffer())
        : new Uint8Array(),
  });
  if (!result.ok) {
    const status =
      result.error === "forbidden"
        ? 403
        : result.error === "file_too_large"
          ? 413
          : 400;
    return Response.json(result, { status });
  }
  return Response.json(result, { status: 201 });
}
