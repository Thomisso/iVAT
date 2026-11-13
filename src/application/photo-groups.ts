import { createHash, randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { isUuid, type AppClient, type SystemClient, type Result } from "./client";
import { splitJob, type JobQueue } from "./processing";
import type { AiInput } from "./ai-provider";
import { SOURCE_FILE_BUCKET, sourceFileDerivativeObjectPath, sourceFileObjectPath, type SourceFileFormat, type SourceFileStatus } from "./source-files";

export type PhotoGroupBasis = { sha256: string; byteSize: number; pages: { page: number; sourceFileId: string; sourceSha256: string; normalizedDerivative?: { format: "jpeg"; sha256: string; byteSize: number }; sha256: string; byteSize: number; width: number; height: number }[] };
export type PhotoGroup = { id: string; companyId: string; batchId: string; sourceFileIds: string[]; createdBy: string; createdAt: string; basis: PhotoGroupBasis | null; preparation: { status: "pending" | "preparing" | "failed" | "ready"; mode: "automatic" | "manual" | "retry"; failure: "temporarily_unavailable" | "evidence_unavailable" | null } };
class PhotoGroupEvidenceError extends Error {}

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const photoGroupPath = (group: PhotoGroup, leaf: string) => `${group.companyId}/${group.sourceFileIds[0]}/group/${leaf}`;

function mapGroup(row: { id: string; company_id: string; upload_batch_id: string; source_file_ids: string[]; created_by: string; created_at: string; basis: unknown; preparation_status: string; preparation_mode: string; preparation_failure: string | null }): PhotoGroup {
  return { id: row.id, companyId: row.company_id, batchId: row.upload_batch_id, sourceFileIds: row.source_file_ids, createdBy: row.created_by, createdAt: row.created_at, basis: row.basis as PhotoGroupBasis | null, preparation: { status: row.preparation_status, mode: row.preparation_mode, failure: row.preparation_failure } as PhotoGroup["preparation"] };
}

/** RLS hides all decisions and processed representations outside Effective Access. */
export async function getPhotoGroup(client: AppClient, companyId: string, groupId: string): Promise<PhotoGroup | null> {
  if (!isUuid(companyId) || !isUuid(groupId)) return null;
  const result = await client.from("photo_group").select("*").eq("company_id", companyId).eq("id", groupId).maybeSingle();
  if (result.error) throw result.error;
  return result.data ? mapGroup(result.data) : null;
}

export async function readPhotoGroupBasis(client: AppClient, companyId: string, groupId: string): Promise<{ group: PhotoGroup; bytes: Uint8Array } | null> {
  const group = await getPhotoGroup(client, companyId, groupId);
  if (!group?.basis) return null;
  const result = await client.storage.from(SOURCE_FILE_BUCKET).download(photoGroupPath(group, "basis.pdf"));
  if (result.error) throw result.error;
  const bytes = new Uint8Array(await result.data.arrayBuffer());
  if (hash(bytes) !== group.basis.sha256 || bytes.length !== group.basis.byteSize) throw new Error("Photo Group basis checksum mismatch");
  return { group, bytes };
}

export type PhotoGroupRecoveryError = "forbidden" | "invalid_choice" | "period_locked" | "source_already_resolved" | "group_evidence_unavailable";

/** Requests preparation of the same frozen group; member recovery is never used. */
export async function recoverPhotoGroup(client: AppClient, jobs: JobQueue, input: { companyId: string; groupId: string; mode: "manual" | "retry" }): Promise<Result<{ id: string }, PhotoGroupRecoveryError>> {
  const group = await getPhotoGroup(client, input.companyId, input.groupId);
  if (!group) return { ok: false, error: "forbidden" };
  const result = await client.rpc("recover_photo_group", { target_group_id: group.id, recovery_mode: input.mode });
  if (result.error) {
    if (result.error.code === "42501") return { ok: false, error: "forbidden" };
    for (const error of ["invalid_choice", "period_locked", "source_already_resolved", "group_evidence_unavailable"] as const) {
      if (result.error.code === "P0001" && result.error.hint === error) return { ok: false, error };
    }
    throw result.error;
  }
  await jobs.send(splitJob(group.sourceFileIds[0]));
  return { ok: true, value: { id: result.data } };
}

/** Worker-only group preparation. No source object is replaced or reinterpreted as a composite. */
export async function preparePhotoGroup(system: SystemClient, sourceFileId: string, final = true): Promise<{ group: PhotoGroup; ready: boolean; terminal?: boolean } | null> {
  const found = await system.from("photo_group").select("*").contains("source_file_ids", [sourceFileId]).maybeSingle();
  if (found.error) throw found.error;
  if (!found.data) return null;
  const group = mapGroup(found.data);
  if (group.basis) return { group, ready: group.preparation.mode !== "manual", terminal: true };
  if (group.preparation.status === "failed") return { group, ready: false, terminal: true };
  const sources: { id: string; sha256: string; format: SourceFileFormat; byte_size: number; status: SourceFileStatus; normalized_format: SourceFileFormat | null; normalized_byte_size: number | null; normalized_sha256: string | null }[] = [];
  // Bound the IN filter independently of the configured group limit. Continue
  // from the last actual row until empty: PostgREST may cap below our request.
  const memberBatchSize = 100;
  for (let start = 0; start < group.sourceFileIds.length; start += memberBatchSize) {
    const ids = group.sourceFileIds.slice(start, start + memberBatchSize);
    let afterId: string | undefined;
    for (;;) {
      let query = system.from("source_file").select("id, sha256, format, byte_size, status, normalized_format, normalized_byte_size, normalized_sha256")
        .eq("company_id", group.companyId).eq("upload_batch_id", group.batchId).in("id", ids)
        .order("id").limit(memberBatchSize);
      if (afterId) query = query.gt("id", afterId);
      const page = await query;
      if (page.error) throw page.error;
      if (!page.data.length) break;
      sources.push(...page.data);
      afterId = page.data.at(-1)!.id;
    }
  }
  if (sources.some(source => !["uploaded", "processing", "waiting_for_platform", "failed"].includes(source.status))) return { group, ready: false, terminal: true };
  if (sources.length !== group.sourceFileIds.length) {
    const batch = await system.from("upload_batch").select("upload_finished_at").eq("id", group.batchId).single();
    if (batch.error) throw batch.error;
    if (batch.data.upload_finished_at) {
      if (final) {
        const failed = await system.rpc("fail_incomplete_photo_group", { target_group_id: group.id, target_request_id: found.data.preparation_request_id });
        if (failed.error) throw failed.error;
      }
      throw new Error("Photo Group original upload incomplete");
    }
    return { group, ready: false };
  }
  const requestId = found.data.preparation_request_id, leaseId = randomUUID();
  const claimed = await system.rpc("claim_photo_group", { target_group_id: group.id, target_request_id: requestId, target_lease_id: leaseId });
  if (claimed.error) throw claimed.error;
  if (!claimed.data) return { group, ready: false };
  const current = async () => {
    const result = await system.rpc("photo_group_claim_current", { target_group_id: group.id, target_request_id: requestId, target_lease_id: leaseId });
    if (result.error) throw result.error;
    return result.data;
  };
  try {
    const limits = await system.from("platform_settings").select("max_source_file_bytes, max_source_file_pages").single();
    if (limits.error) throw limits.error;
    if (group.sourceFileIds.length > limits.data.max_source_file_pages || sources.reduce((sum, source) => sum + Number(source.byte_size), 0) > limits.data.max_source_file_bytes) throw new Error("Photo Group exceeds platform limits");
    const pdf = await PDFDocument.create();
    pdf.setCreationDate(new Date("1980-01-01T00:00:00Z"));
    pdf.setModificationDate(new Date("1980-01-01T00:00:00Z"));
    const basis: PhotoGroupBasis = { sha256: "", byteSize: 0, pages: [] };
    let pixels = 0, bytesTotal = 0, inputBytes = 0;
    for (const [index, id] of group.sourceFileIds.entries()) {
      const source = sources.find(source => source.id === id)!;
      if (!["jpeg", "png", "heic", "heif"].includes(source.format)) throw new PhotoGroupEvidenceError("Photo Group source format unsupported");
      const original = await system.storage.from(SOURCE_FILE_BUCKET).download(sourceFileObjectPath(group.companyId, id));
      if (original.error) throw original.error;
      const raw = new Uint8Array(await original.data.arrayBuffer());
      if (raw.length !== Number(source.byte_size) || hash(raw) !== source.sha256) throw new PhotoGroupEvidenceError("Photo Group original checksum mismatch");
      let input = raw;
      let normalizedDerivative: PhotoGroupBasis["pages"][number]["normalizedDerivative"];
      if (source.format === "heic" || source.format === "heif") {
        if (source.normalized_format !== "jpeg" || !source.normalized_byte_size || !source.normalized_sha256) throw new PhotoGroupEvidenceError("Photo Group normalization metadata unavailable");
        if (Number(source.normalized_byte_size) > limits.data.max_source_file_bytes) throw new Error("Photo Group normalization exceeds platform limit");
        const stored = await system.storage.from(SOURCE_FILE_BUCKET).download(sourceFileDerivativeObjectPath(group.companyId, id));
        if (stored.error) throw stored.error;
        input = new Uint8Array(await stored.data.arrayBuffer());
        if (input.length !== Number(source.normalized_byte_size) || hash(input) !== source.normalized_sha256) throw new PhotoGroupEvidenceError("Photo Group normalization checksum mismatch");
        normalizedDerivative = { format: "jpeg", sha256: source.normalized_sha256, byteSize: input.length };
      }
      inputBytes += input.length;
      if (inputBytes > limits.data.max_source_file_bytes) throw new Error("Photo Group normalized input exceeds platform limit");
      // Orientation is applied to the stored processed pages, never to originals.
      const png = await sharp(input, { limitInputPixels: 8_000_000 }).rotate().png().toBuffer({ resolveWithObject: true })
        .catch(() => { throw new PhotoGroupEvidenceError("Photo Group photograph cannot be decoded"); });
      pixels += png.info.width * png.info.height; bytesTotal += png.data.length;
      if (bytesTotal > limits.data.max_source_file_bytes) throw new Error("Photo Group processed basis exceeds platform limit");
      if (pixels > 100_000_000 || bytesTotal > 18 * 1024 * 1024 || png.data.length > 3 * 1024 * 1024
        || Math.max(png.info.width, png.info.height) > (group.sourceFileIds.length > 20 ? 2000 : 8000)) throw new PhotoGroupEvidenceError("Photo Group processed basis exceeds rendering limits");
      const image = await pdf.embedPng(png.data);
      const page = pdf.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      if (!(await current())) return { group, ready: false, terminal: true };
      await storeBasis(system, photoGroupPath(group, `${index + 1}.png`), png.data, "image/png");
      basis.pages.push({ page: index + 1, sourceFileId: id, sourceSha256: source.sha256, ...(normalizedDerivative ? { normalizedDerivative } : {}), sha256: hash(png.data), byteSize: png.data.length, width: image.width, height: image.height });
    }
    const bytes = await pdf.save();
    basis.sha256 = hash(bytes); basis.byteSize = bytes.length;
    if (bytes.length > limits.data.max_source_file_bytes) throw new Error("Photo Group PDF basis exceeds platform limit");
    if (!(await current())) return { group, ready: false, terminal: true };
    await storeBasis(system, photoGroupPath(group, "basis.pdf"), bytes, "application/pdf");
    const completed = await system.rpc("complete_photo_group", { target_group_id: group.id, processed_basis: basis, target_request_id: requestId, target_lease_id: leaseId });
    if (completed.error) throw completed.error;
    if (!completed.data) return { group, ready: false, terminal: true };
    return { group: { ...group, basis, preparation: { ...group.preparation, status: "ready", failure: null } }, ready: group.preparation.mode !== "manual", terminal: group.preparation.mode === "manual" };
  } catch (error) {
    // A superseded worker cannot fail a takeover or dispatch its Extraction.
    if (!(await current())) return { group, ready: false, terminal: true };
    if (final) {
      const permanent = error instanceof PhotoGroupEvidenceError
        || (typeof error === "object" && error !== null && "statusCode" in error && String(error.statusCode) === "404");
      const failed = await system.rpc("fail_photo_group", { target_group_id: group.id, target_request_id: requestId, target_lease_id: leaseId,
        failure_code: permanent ? "evidence_unavailable" : "temporarily_unavailable" });
      if (failed.error) throw failed.error;
    } else {
      // Release this failed attempt; the durable queue may retry it immediately.
      const released = await system.rpc("release_photo_group_claim", { target_group_id: group.id, target_request_id: requestId, target_lease_id: leaseId });
      if (released.error) throw released.error;
    }
    throw error;
  }
}

async function storeBasis(system: SystemClient, path: string, bytes: Uint8Array, contentType: string) {
  const result = await system.storage.from(SOURCE_FILE_BUCKET).upload(path, bytes, { contentType, upsert: false });
  if (!result.error) return;
  if (!("statusCode" in result.error) || result.error.statusCode !== "409") throw result.error;
  const stored = await system.storage.from(SOURCE_FILE_BUCKET).download(path);
  if (stored.error) throw stored.error;
  if (hash(new Uint8Array(await stored.data.arrayBuffer())) !== hash(bytes)) throw new PhotoGroupEvidenceError("Photo Group basis cannot be replaced");
}

/** Supplies precisely the stored PNGs used to build the review PDF, in manifest order. */
export async function photoGroupAiInput(system: SystemClient, documentId: string): Promise<{ group: PhotoGroup; input: AiInput } | null> {
  const result = await system.from("photo_group").select("*").eq("id", documentId).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return null;
  const group = mapGroup(result.data);
  if (!group.basis) throw new Error("Photo Group basis is unavailable");
  const read = async (leaf: string, expectedHash: string, byteSize: number) => {
    const stored = await system.storage.from(SOURCE_FILE_BUCKET).download(photoGroupPath(group, leaf));
    if (stored.error) throw stored.error;
    const bytes = new Uint8Array(await stored.data.arrayBuffer());
    if (hash(bytes) !== expectedHash || bytes.length !== byteSize) throw new Error("Photo Group basis checksum mismatch");
    return bytes;
  };
  const bytes = await read("basis.pdf", group.basis.sha256, group.basis.byteSize);
  const pageImages = [];
  for (const page of group.basis.pages) pageImages.push({ mediaType: "image/png" as const, bytes: await read(`${page.page}.png`, page.sha256, page.byteSize), width: page.width, height: page.height });
  return { group, input: { format: "pdf", mediaType: "application/pdf", bytes, pageCount: pageImages.length, pageImages } };
}

/** Used by both public archive paths after their snapshot authorization. */
export async function readPhotoGroupObject(client: AppClient, path: string): Promise<Uint8Array> {
  const stored = await client.storage.from(SOURCE_FILE_BUCKET).download(path);
  if (stored.error) throw stored.error;
  return new Uint8Array(await stored.data.arrayBuffer());
}

/** A group membership is a relationship, never a replacement of the original's identity. */
export async function getSourcePhotoGroup(client: AppClient, companyId: string, sourceFileId: string): Promise<PhotoGroup | null> {
  if (!isUuid(companyId) || !isUuid(sourceFileId)) return null;
  const result = await client.from("photo_group").select("*").eq("company_id", companyId).contains("source_file_ids", [sourceFileId]).maybeSingle();
  if (result.error) throw result.error;
  return result.data ? mapGroup(result.data) : null;
}
