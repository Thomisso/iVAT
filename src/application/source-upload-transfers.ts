import { SOURCE_UPLOAD_CHUNK_BYTES } from "@/lib/upload-policy";
import { createHash } from "node:crypto";
import { isUuid, type AppClient, type Result } from "./client";
import { splitJob, type JobQueue } from "./processing";
import { type UploadSourceFileError } from "./source-files";

export type SourceUploadIdentity = {
  companyId: string;
  batchId: string;
  sourceFileId: string;
  fileName: string;
  byteSize: number;
  sha256: string;
};
export interface SourceUploadValidation { validateAndStage(claimId: string): Promise<Result<string, SourceUploadError>>; }

export type SourceUploadAttempt = SourceUploadIdentity & { expectedAttemptId: string | null };
export type SourceUploadProgress = { attemptId: string | null; confirmedBytes: number; byteSize: number; complete: boolean };
export type SourceUploadError = UploadSourceFileError | "upload_incomplete" | "upload_checksum_mismatch" | "upload_expired" | "upload_cancelled" | "upload_attempt_changed";
export type SourceUploadResult<T> = { ok: true; value: T } | { ok: false; error: SourceUploadError; attemptId?: string };

const BUCKET = "source-upload-chunks";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const objectPath = (identity: SourceUploadIdentity, attemptId: string, legacy: boolean, offset: number, sha256: string) =>
  `${identity.companyId}/${identity.sourceFileId}/${legacy ? "" : `${attemptId}/`}${offset}/${sha256}`;

function refusal(error: { code?: string; hint?: string; details?: string }): SourceUploadResult<never> {
  if (error.code === "42501") return { ok: false, error: "forbidden" };
  for (const code of ["invalid_choice", "file_too_large", "too_many_files", "upload_expired", "upload_cancelled", "upload_attempt_changed", "upload_incomplete", "too_many_pages", "identical_file", "unsupported_format"] as const) {
    if (error.code === "P0001" && error.hint === code) return { ok: false, error: code, ...((code === "upload_expired" || code === "upload_cancelled") && error.details && isUuid(error.details) ? { attemptId: error.details } : {}) };
  }
  throw error;
}

function validIdentity(identity: SourceUploadIdentity): boolean {
  return [identity.companyId, identity.batchId, identity.sourceFileId].every(isUuid)
    && typeof identity.fileName === "string" && Number.isSafeInteger(identity.byteSize) && identity.byteSize > 0
    && typeof identity.sha256 === "string" && /^[0-9a-f]{64}$/.test(identity.sha256);
}

/** Reauthorizes the immutable manifest item on every attempt; local estimates are never input. */
export async function reconcileSourceUpload(client: AppClient, identity: SourceUploadIdentity, expectedAttemptId?: string | null): Promise<SourceUploadResult<SourceUploadProgress>> {
  if (!validIdentity(identity) || (expectedAttemptId != null && !isUuid(expectedAttemptId))) return { ok: false, error: "invalid_choice" };
  const { data, error } = await client.rpc("reconcile_source_upload", {
    target_company_id: identity.companyId, target_batch_id: identity.batchId, target_source_file_id: identity.sourceFileId,
    original_file_name: identity.fileName, original_byte_size: identity.byteSize, original_sha256: identity.sha256,
    ...(expectedAttemptId ? { expected_attempt_id: expectedAttemptId } : {}),
  });
  if (error) return refusal(error);
  return { ok: true, value: data as SourceUploadProgress };
}

/** An explicit full restart preserves the immutable item and names its retired attempt. */
export async function restartSourceUpload(client: AppClient, input: SourceUploadAttempt): Promise<SourceUploadResult<SourceUploadProgress>> {
  if (!validIdentity(input) || !input.expectedAttemptId || !isUuid(input.expectedAttemptId)) return { ok: false, error: "invalid_choice" };
  const { data, error } = await client.rpc("restart_source_upload", {
    target_company_id: input.companyId, target_batch_id: input.batchId, target_source_file_id: input.sourceFileId,
    original_file_name: input.fileName, original_byte_size: input.byteSize, original_sha256: input.sha256,
    expected_attempt_id: input.expectedAttemptId,
  });
  if (error) return refusal(error);
  return { ok: true, value: data as SourceUploadProgress };
}

/** Explicit cancellation retires only the named current attempt. */
export async function cancelSourceUpload(client: AppClient, input: SourceUploadAttempt): Promise<SourceUploadResult<SourceUploadProgress>> {
  if (!validIdentity(input) || !input.expectedAttemptId || !isUuid(input.expectedAttemptId)) return { ok: false, error: "invalid_choice" };
  const { data, error } = await client.rpc("cancel_source_upload", {
    target_company_id: input.companyId, target_batch_id: input.batchId, target_source_file_id: input.sourceFileId,
    original_file_name: input.fileName, original_byte_size: input.byteSize, original_sha256: input.sha256,
    expected_attempt_id: input.expectedAttemptId,
  });
  if (error) return refusal(error);
  return { ok: true, value: data as SourceUploadProgress };
}

/** A denial can arrive after initial admission because time, authority or the
 * current attempt changed while Storage was in flight. Reconsult SQL authority. */
async function afterStorageRefusal(client: AppClient, identity: SourceUploadAttempt, missing = false): Promise<SourceUploadResult<SourceUploadProgress>> {
  const current = await reconcileSourceUpload(client, identity, identity.expectedAttemptId);
  if (!current.ok || current.value.complete) return current;
  return { ok: false, error: missing ? "upload_incomplete" : "forbidden" };
}

/** Stores immutable bytes before atomically confirming their contiguous offset. */
export async function appendSourceUpload(client: AppClient, input: SourceUploadAttempt & { offset: number; bytes: Uint8Array }): Promise<SourceUploadResult<SourceUploadProgress>> {
  if (input.expectedAttemptId !== null && !isUuid(input.expectedAttemptId)) return { ok: false, error: "invalid_choice" };
  const state = await reconcileSourceUpload(client, input, input.expectedAttemptId);
  if (!state.ok) return state;
  if (state.value.attemptId !== input.expectedAttemptId) return { ok: false, error: "upload_attempt_changed" };
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.bytes.length < 1
    || input.bytes.length > SOURCE_UPLOAD_CHUNK_BYTES || input.offset + input.bytes.length > input.byteSize
    || input.offset > state.value.confirmedBytes) return { ok: false, error: "invalid_choice" };
  if (state.value.complete) return state;
  if (!input.expectedAttemptId) return { ok: false, error: "invalid_choice" };
  const sha256 = hash(input.bytes);
  if (input.offset < state.value.confirmedBytes) {
    const previous = await client.from("source_upload_chunk").select("byte_size, sha256")
      .eq("source_file_id", input.sourceFileId).eq("attempt_id", input.expectedAttemptId).eq("byte_offset", input.offset).maybeSingle();
    if (previous.error) return refusal(previous.error);
    if (!previous.data || previous.data.byte_size !== input.bytes.length || previous.data.sha256 !== sha256) {
      const current = await reconcileSourceUpload(client, input, input.expectedAttemptId);
      if (!current.ok || current.value.complete) return current;
      return { ok: false, error: "invalid_choice" };
    }
  }
  const transfer = await client.from("source_upload_transfer").select("legacy_layout")
    .eq("source_file_id", input.sourceFileId).eq("attempt_id", input.expectedAttemptId).maybeSingle();
  if (transfer.error) return refusal(transfer.error);
  if (!transfer.data) {
    const current = await reconcileSourceUpload(client, input, input.expectedAttemptId);
    if (!current.ok || current.value.complete) return current;
    return { ok: false, error: "upload_attempt_changed" };
  }
  const path = objectPath(input, input.expectedAttemptId, transfer.data.legacy_layout, input.offset, sha256);
  const stored = await client.storage.from(BUCKET).upload(path, input.bytes, { contentType: "application/octet-stream", upsert: false });
  if (stored.error) {
    if ("statusCode" in stored.error && stored.error.statusCode === "403") return afterStorageRefusal(client, input);
    if (!("statusCode" in stored.error) || stored.error.statusCode !== "409") throw stored.error;
    const existing = await client.storage.from(BUCKET).download(path);
    if (existing.error) {
      if ("statusCode" in existing.error && ["403", "404"].includes(String(existing.error.statusCode))) return afterStorageRefusal(client, input, String(existing.error.statusCode) === "404");
      throw existing.error;
    }
    if (hash(new Uint8Array(await existing.data.arrayBuffer())) !== sha256) return { ok: false, error: "invalid_choice" };
  }
  const confirmed = await client.rpc("confirm_source_upload_chunk", {
    target_source_file_id: input.sourceFileId, expected_attempt_id: input.expectedAttemptId, chunk_offset: input.offset, chunk_byte_size: input.bytes.length, chunk_sha256: sha256,
  });
  if (confirmed.error) return refusal(confirmed.error);
  return { ok: true, value: confirmed.data as SourceUploadProgress };
}

/** Only assembled, size/format/limit/hash-verified originals enter the existing immutable upload pipeline. */
export async function completeSourceUpload(client: AppClient, jobs: JobQueue, identity: SourceUploadAttempt, validator: SourceUploadValidation): Promise<SourceUploadResult<{ id: string }>> {
  if (identity.expectedAttemptId !== null && !isUuid(identity.expectedAttemptId)) return { ok: false, error: "invalid_choice" };
  const state = await reconcileSourceUpload(client, identity, identity.expectedAttemptId);
  if (!state.ok) return state;
  if (state.value.attemptId !== identity.expectedAttemptId) return { ok: false, error: "upload_attempt_changed" };
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
  if (!identity.expectedAttemptId) return { ok: false, error: "invalid_choice" };
  const args = { target_company_id: identity.companyId, target_batch_id: identity.batchId, target_source_file_id: identity.sourceFileId,
    original_file_name: identity.fileName, original_byte_size: identity.byteSize, original_sha256: identity.sha256, expected_attempt_id: identity.expectedAttemptId };
  const claim = await client.rpc("begin_source_upload_validation", args);
  if (claim.error) return refusal(claim.error);
  try {
    const verified = await validator.validateAndStage(claim.data);
    if (!verified.ok) {
      const current = await reconcileSourceUpload(client, identity, identity.expectedAttemptId);
      if (!current.ok) return current;
      if (!current.value.complete) return verified;
    } else {
      const published = await client.rpc("publish_source_upload", { ...args, validation_claim_id: verified.value });
      if (published.error) return refusal(published.error);
    }
  } catch (error) {
    const current = await reconcileSourceUpload(client, identity, identity.expectedAttemptId);
    if (!current.ok) return current;
    if (!current.value.complete) throw error;
  }
  await dispatch.send(splitJob(identity.sourceFileId));
  return { ok: true, value: { id: identity.sourceFileId } };
}
