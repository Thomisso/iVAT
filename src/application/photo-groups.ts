import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { isUuid, type AppClient, type SystemClient } from "./client";
import type { AiInput } from "./ai-provider";
import { SOURCE_FILE_BUCKET, sourceFileObjectPath, type SourceFileFormat, type SourceFileStatus } from "./source-files";

export type PhotoGroupBasis = { sha256: string; byteSize: number; pages: { page: number; sourceFileId: string; sourceSha256: string; sha256: string; byteSize: number; width: number; height: number }[] };
export type PhotoGroup = { id: string; companyId: string; batchId: string; sourceFileIds: string[]; createdBy: string; createdAt: string; basis: PhotoGroupBasis | null };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const photoGroupPath = (group: PhotoGroup, leaf: string) => `${group.companyId}/${group.sourceFileIds[0]}/group/${leaf}`;

function mapGroup(row: { id: string; company_id: string; upload_batch_id: string; source_file_ids: string[]; created_by: string; created_at: string; basis: unknown }): PhotoGroup {
  return { id: row.id, companyId: row.company_id, batchId: row.upload_batch_id, sourceFileIds: row.source_file_ids, createdBy: row.created_by, createdAt: row.created_at, basis: row.basis as PhotoGroupBasis | null };
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

/** Worker-only group preparation. No source object is replaced or reinterpreted as a composite. */
export async function preparePhotoGroup(system: SystemClient, sourceFileId: string): Promise<{ group: PhotoGroup; ready: boolean; terminal?: boolean } | null> {
  const found = await system.from("photo_group").select("*").contains("source_file_ids", [sourceFileId]).maybeSingle();
  if (found.error) throw found.error;
  if (!found.data) return null;
  const group = mapGroup(found.data);
  if (group.basis) return { group, ready: true };
  const sources: { id: string; sha256: string; format: SourceFileFormat; byte_size: number; status: SourceFileStatus }[] = [];
  // Bound the IN filter independently of the configured group limit. Continue
  // from the last actual row until empty: PostgREST may cap below our request.
  const memberBatchSize = 100;
  for (let start = 0; start < group.sourceFileIds.length; start += memberBatchSize) {
    const ids = group.sourceFileIds.slice(start, start + memberBatchSize);
    let afterId: string | undefined;
    for (;;) {
      let query = system.from("source_file").select("id, sha256, format, byte_size, status")
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
  if (sources.some(source => !["uploaded", "processing", "waiting_for_platform"].includes(source.status))) return { group, ready: false, terminal: true };
  if (sources.length !== group.sourceFileIds.length) {
    const batch = await system.from("upload_batch").select("upload_finished_at").eq("id", group.batchId).single();
    if (batch.error) throw batch.error;
    if (batch.data.upload_finished_at) throw new Error("Photo Group original upload incomplete");
    return { group, ready: false };
  }
  const limits = await system.from("platform_settings").select("max_source_file_bytes, max_source_file_pages").single();
  if (limits.error) throw limits.error;
  if (group.sourceFileIds.length > limits.data.max_source_file_pages || sources.reduce((sum, source) => sum + Number(source.byte_size), 0) > limits.data.max_source_file_bytes) throw new Error("Photo Group exceeds platform limits");
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date("1980-01-01T00:00:00Z"));
  pdf.setModificationDate(new Date("1980-01-01T00:00:00Z"));
  const basis: PhotoGroupBasis = { sha256: "", byteSize: 0, pages: [] };
  let pixels = 0, bytesTotal = 0;
  for (const [index, id] of group.sourceFileIds.entries()) {
    const source = sources.find(source => source.id === id)!;
    if (!["jpeg", "png"].includes(source.format)) throw new Error("Photo Group source format unsupported");
    const original = await system.storage.from(SOURCE_FILE_BUCKET).download(sourceFileObjectPath(group.companyId, id));
    if (original.error) throw original.error;
    const raw = new Uint8Array(await original.data.arrayBuffer());
    if (raw.length !== Number(source.byte_size) || hash(raw) !== source.sha256) throw new Error("Photo Group original checksum mismatch");
    // Orientation is applied to the stored processed pages, never to originals.
    const png = await sharp(raw, { limitInputPixels: 8_000_000 }).rotate().png().toBuffer({ resolveWithObject: true });
    pixels += png.info.width * png.info.height; bytesTotal += png.data.length;
    if (pixels > 100_000_000 || bytesTotal > Math.min(18 * 1024 * 1024, limits.data.max_source_file_bytes) || png.data.length > 3 * 1024 * 1024
      || Math.max(png.info.width, png.info.height) > (group.sourceFileIds.length > 20 ? 2000 : 8000)) throw new Error("Photo Group processed basis exceeds rendering limits");
    const image = await pdf.embedPng(png.data);
    const page = pdf.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    await storeBasis(system, photoGroupPath(group, `${index + 1}.png`), png.data, "image/png");
    basis.pages.push({ page: index + 1, sourceFileId: id, sourceSha256: source.sha256, sha256: hash(png.data), byteSize: png.data.length, width: image.width, height: image.height });
  }
  const bytes = await pdf.save();
  basis.sha256 = hash(bytes); basis.byteSize = bytes.length;
  if (bytes.length > limits.data.max_source_file_bytes) throw new Error("Photo Group PDF basis exceeds platform limit");
  await storeBasis(system, photoGroupPath(group, "basis.pdf"), bytes, "application/pdf");
  const completed = await system.rpc("complete_photo_group", { target_group_id: group.id, processed_basis: basis });
  if (completed.error) throw completed.error;
  return { group: { ...group, basis }, ready: true };
}

async function storeBasis(system: SystemClient, path: string, bytes: Uint8Array, contentType: string) {
  const result = await system.storage.from(SOURCE_FILE_BUCKET).upload(path, bytes, { contentType, upsert: false });
  if (!result.error) return;
  if (!("statusCode" in result.error) || result.error.statusCode !== "409") throw result.error;
  const stored = await system.storage.from(SOURCE_FILE_BUCKET).download(path);
  if (stored.error) throw stored.error;
  if (hash(new Uint8Array(await stored.data.arrayBuffer())) !== hash(bytes)) throw new Error("Photo Group basis cannot be replaced");
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
