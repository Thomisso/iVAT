import { SOURCE_UPLOAD_CHUNK_BYTES } from "@/lib/upload-policy";
import { createHash } from "node:crypto";
import { isUuid, type AppClient, type Result } from "./client";
import { splitJob, type JobQueue } from "./processing";
import { uploadSourceFile, type UploadSourceFileError } from "./source-files";

export type SourceUploadIdentity = {
  companyId: string;
  batchId: string;
  sourceFileId: string;
  fileName: string;
  byteSize: number;
  sha256: string;
};
export type SourceUploadProgress = { confirmedBytes: number; byteSize: number; complete: boolean };
export type SourceUploadError = UploadSourceFileError | "upload_incomplete" | "upload_checksum_mismatch";

const BUCKET = "source-upload-chunks";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const objectPath = (identity: SourceUploadIdentity, offset: number, sha256: string) =>
  `${identity.companyId}/${identity.sourceFileId}/${offset}/${sha256}`;

function refusal(error: { code?: string; hint?: string }): Result<never, SourceUploadError> {
  if (error.code === "42501") return { ok: false, error: "forbidden" };
  for (const code of ["invalid_choice", "file_too_large", "too_many_files"] as const) {
    if (error.code === "P0001" && error.hint === code) return { ok: false, error: code };
  }
  throw error;
}

/** Reauthorizes the immutable manifest item on every attempt; local estimates are never input. */
export async function reconcileSourceUpload(client: AppClient, identity: SourceUploadIdentity): Promise<Result<SourceUploadProgress, SourceUploadError>> {
  if (![identity.companyId, identity.batchId, identity.sourceFileId].every(isUuid)
    || typeof identity.fileName !== "string" || !Number.isSafeInteger(identity.byteSize) || identity.byteSize < 1
    || typeof identity.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(identity.sha256)) return { ok: false, error: "invalid_choice" };
  const { data, error } = await client.rpc("reconcile_source_upload", {
    target_company_id: identity.companyId, target_batch_id: identity.batchId, target_source_file_id: identity.sourceFileId,
    original_file_name: identity.fileName, original_byte_size: identity.byteSize, original_sha256: identity.sha256,
  });
  if (error) return refusal(error);
  return { ok: true, value: data as SourceUploadProgress };
}

/** Stores immutable bytes before atomically confirming their contiguous offset. */
export async function appendSourceUpload(client: AppClient, input: SourceUploadIdentity & { offset: number; bytes: Uint8Array }): Promise<Result<SourceUploadProgress, SourceUploadError>> {
  const state = await reconcileSourceUpload(client, input);
  if (!state.ok) return state;
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.bytes.length < 1
    || input.bytes.length > SOURCE_UPLOAD_CHUNK_BYTES || input.offset + input.bytes.length > input.byteSize
    || input.offset > state.value.confirmedBytes) return { ok: false, error: "invalid_choice" };
  const sha256 = hash(input.bytes);
  if (input.offset < state.value.confirmedBytes) {
    const previous = await client.from("source_upload_chunk").select("byte_size, sha256")
      .eq("source_file_id", input.sourceFileId).eq("byte_offset", input.offset).maybeSingle();
    if (previous.error) return refusal(previous.error);
    if (!previous.data || previous.data.byte_size !== input.bytes.length || previous.data.sha256 !== sha256) return { ok: false, error: "invalid_choice" };
  }
  if (state.value.complete) return state;
  const path = objectPath(input, input.offset, sha256);
  const stored = await client.storage.from(BUCKET).upload(path, input.bytes, { contentType: "application/octet-stream", upsert: false });
  if (stored.error) {
    if ("statusCode" in stored.error && stored.error.statusCode === "403") return { ok: false, error: "forbidden" };
    if (!("statusCode" in stored.error) || stored.error.statusCode !== "409") throw stored.error;
    const existing = await client.storage.from(BUCKET).download(path);
    if (existing.error) throw existing.error;
    if (hash(new Uint8Array(await existing.data.arrayBuffer())) !== sha256) return { ok: false, error: "invalid_choice" };
  }
  const confirmed = await client.rpc("confirm_source_upload_chunk", {
    target_source_file_id: input.sourceFileId, chunk_offset: input.offset, chunk_byte_size: input.bytes.length, chunk_sha256: sha256,
  });
  if (confirmed.error) return refusal(confirmed.error);
  return { ok: true, value: confirmed.data as SourceUploadProgress };
}

/** Only assembled, size/format/limit/hash-verified originals enter the existing immutable upload pipeline. */
export async function completeSourceUpload(client: AppClient, jobs: JobQueue, identity: SourceUploadIdentity): Promise<Result<{ id: string }, SourceUploadError>> {
  const state = await reconcileSourceUpload(client, identity);
  if (!state.ok) return state;
  // The existing processing request UUID is also the durable queue identity.
  // Concurrent sends and lost enqueue responses cannot create a second Split job;
  // a genuine failed attempt remains retryable within that same pg-boss job.
  const dispatch: JobQueue = {
    async send(job) {
      const source = await client.from("source_file").select("split_request_id")
        .eq("company_id", identity.companyId).eq("id", identity.sourceFileId).maybeSingle();
      if (source.error) throw source.error;
      if (!source.data) throw new Error("Completed Source File is unavailable for dispatch");
      await jobs.send(job, { jobId: source.data.split_request_id });
    },
  };
  // A lost response can be retried after the Batch has finished or limits changed.
  // Retry dispatch too: a prior response can be lost between recording and enqueueing.
  if (state.value.complete) {
    await dispatch.send(splitJob(identity.sourceFileId));
    return { ok: true, value: { id: identity.sourceFileId } };
  }
  if (state.value.confirmedBytes !== identity.byteSize) return { ok: false, error: "upload_incomplete" };
  const bytes = new Uint8Array(identity.byteSize);
  let offset = 0;
  // Paginate because a platform limit can permit more portions than PostgREST's row cap.
  while (offset < identity.byteSize) {
    const { data, error } = await client.from("source_upload_chunk").select("byte_offset, byte_size, sha256")
      .eq("source_file_id", identity.sourceFileId).gte("byte_offset", offset).order("byte_offset").limit(1000);
    if (error) return refusal(error);
    if (!data.length) return { ok: false, error: "upload_incomplete" };
    for (const chunk of data) {
      if (Number(chunk.byte_offset) !== offset) return { ok: false, error: "upload_incomplete" };
      const stored = await client.storage.from(BUCKET).download(objectPath(identity, offset, chunk.sha256));
      if (stored.error) {
        if ("statusCode" in stored.error && stored.error.statusCode === "403") return { ok: false, error: "forbidden" };
        throw stored.error;
      }
      const portion = new Uint8Array(await stored.data.arrayBuffer());
      if (portion.length !== chunk.byte_size || hash(portion) !== chunk.sha256) return { ok: false, error: "upload_checksum_mismatch" };
      bytes.set(portion, offset);
      offset += portion.length;
    }
  }
  if (hash(bytes) !== identity.sha256) return { ok: false, error: "upload_checksum_mismatch" };
  return uploadSourceFile(client, dispatch, { ...identity, bytes });
}
