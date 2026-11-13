import { appendSourceUpload, cancelSourceUpload, completeSourceUpload, reconcileSourceUpload, restartSourceUpload, type SourceUploadIdentity, type SourceUploadAttempt } from "@/application/source-upload-transfers";
import { SOURCE_UPLOAD_CHUNK_BYTES } from "@/lib/upload-policy";
import { jobQueue } from "@/lib/jobs";
import { requireUserClient } from "@/lib/supabase/server";

type Context = RouteContext<"/companies/[companyId]/source-files/[sourceFileId]/transfer">;
const respond = (result: { ok: boolean; error?: string }, successStatus = 200) => Response.json(result, {
  status: result.ok ? successStatus : result.error === "forbidden" ? 403 : result.error === "file_too_large" ? 413 : result.error === "upload_expired" || result.error === "upload_cancelled" ? 410 : result.error === "upload_attempt_changed" ? 409 : 400,
  headers: { "Cache-Control": "no-store" },
});

async function readBody(request: Request, maximum: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > maximum) { await reader.cancel(); return null; }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks, size);
}

/** Reconcile before transfer, or finalize the same manifest item after all bytes are confirmed. */
export async function POST(request: Request, ctx: Context) {
  const client = await requireUserClient();
  const params = await ctx.params;
  const bytes = await readBody(request, 64 * 1024);
  if (!bytes) return respond({ ok: false, error: "invalid_choice" });
  let input: Partial<SourceUploadIdentity> & { complete?: boolean; restart?: boolean; cancel?: boolean; expectedAttemptId?: string | null };
  try { input = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { return respond({ ok: false, error: "invalid_choice" }); }
  if (!input || typeof input !== "object") return respond({ ok: false, error: "invalid_choice" });
  const identity = { ...input, ...params } as SourceUploadIdentity;
  if (input.cancel === true) return respond(await cancelSourceUpload(client, identity as SourceUploadAttempt));
  if (input.restart === true) return respond(await restartSourceUpload(client, identity as SourceUploadAttempt));
  return input.complete === true
    ? respond(await completeSourceUpload(client, jobQueue, identity as SourceUploadAttempt), 201)
    : respond(await reconcileSourceUpload(client, identity, input.expectedAttemptId));
}

/** Body bytes are bounded before allocation; identity stays out of query strings and access logs. */
export async function PUT(request: Request, ctx: Context) {
  const client = await requireUserClient();
  const params = await ctx.params;
  let fileName: string;
  try { fileName = decodeURIComponent(request.headers.get("Upload-File-Name") ?? ""); }
  catch { return respond({ ok: false, error: "invalid_choice" }); }
  const bytes = await readBody(request, SOURCE_UPLOAD_CHUNK_BYTES);
  if (!bytes) return respond({ ok: false, error: "file_too_large" });
  return respond(await appendSourceUpload(client, {
    ...params, batchId: request.headers.get("Upload-Batch-Id") ?? "", fileName,
    byteSize: Number(request.headers.get("Upload-Byte-Size")), sha256: request.headers.get("Upload-Sha256") ?? "",
    expectedAttemptId: request.headers.get("Upload-Attempt-Id") ?? "",
    offset: Number(request.headers.get("Upload-Offset") ?? NaN), bytes,
  }));
}
