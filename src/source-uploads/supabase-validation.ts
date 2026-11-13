import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { Database } from "@/lib/database.types";
import type { SourceUploadValidation } from "@/application/source-upload-transfers";
import { inspectSourceFile, normalizedDerivative, SOURCE_FILE_MEDIA_TYPES, type UploadLimits } from "@/application/source-files";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** This adapter exposes factual validation only, never publication or user impersonation. */
export function supabaseSourceUploadValidation(configuration: { url: string; secretKey: string; fetch?: typeof fetch }): SourceUploadValidation {
  const administration = createClient<Database>(configuration.url, configuration.secretKey, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: configuration.fetch } });
  async function download(bucket: string, path: string) {
    const stored = await administration.storage.from(bucket).download(path);
    if (stored.error) throw stored.error;
    return new Uint8Array(await stored.data.arrayBuffer());
  }
  async function store(path: string, bytes: Uint8Array, contentType: string) {
    const saved = await administration.storage.from("source-files").upload(path, bytes, { contentType, upsert: false });
    if (saved.error && (!("statusCode" in saved.error) || String(saved.error.statusCode) !== "409")) throw saved.error;
    const actual = await download("source-files", path);
    if (actual.length !== bytes.length || hash(actual) !== hash(bytes)) throw new Error("Immutable validated object content mismatch");
  }
  return { async validateAndStage(claimId) {
    const loaded = await administration.rpc("source_upload_validation_input", { claim_id: claimId });
    if (loaded.error) throw loaded.error;
    const input = loaded.data as { validated: boolean; legacy?: boolean; fileName: string; byteSize: number; sha256: string; originalPath: string; derivativePath: string; limits: UploadLimits;
      chunks: { offset: number; byteSize: number; sha256: string; path: string }[] };
    if (input.validated) return { ok: true, value: claimId };
    const bytes = input.legacy ? await download("source-files", input.originalPath) : new Uint8Array(input.byteSize);
    let offset = input.legacy ? bytes.length : 0;
    for (const chunk of input.chunks ?? []) {
      if (chunk.offset !== offset || offset + chunk.byteSize > bytes.length) return { ok: false, error: "upload_incomplete" };
      const actual = await download("source-upload-chunks", chunk.path);
      if (actual.length !== chunk.byteSize || hash(actual) !== chunk.sha256) return { ok: false, error: "upload_checksum_mismatch" };
      bytes.set(actual, offset); offset += actual.length;
    }
    if (bytes.length !== input.byteSize) return { ok: false, error: "upload_checksum_mismatch" };
    if (offset !== bytes.length) return { ok: false, error: "upload_incomplete" };
    if (hash(bytes) !== input.sha256) return { ok: false, error: "upload_checksum_mismatch" };
    const prepared = await inspectSourceFile({ fileName: input.fileName, bytes }, input.limits);
    if (!prepared.ok) return prepared;
    const derivative = await normalizedDerivative(prepared.value.format, bytes);
    if (["heic", "heif"].includes(prepared.value.format) && !derivative) return { ok: false, error: "unreadable_file" };
    await store(input.originalPath, bytes, SOURCE_FILE_MEDIA_TYPES[prepared.value.format]);
    if (derivative) await store(input.derivativePath, derivative, "image/jpeg");
    const recorded = await administration.rpc("record_source_upload_validation", { claim_id: claimId, actual_sha256: hash(bytes), actual_byte_size: bytes.length,
      actual_format: prepared.value.format, actual_page_count: prepared.value.pageCount,
      ...(derivative ? { normalized_sha256: hash(derivative), normalized_byte_size: derivative.length } : {}) });
    if (recorded.error) throw recorded.error;
    return { ok: true, value: recorded.data };
  } };
}
