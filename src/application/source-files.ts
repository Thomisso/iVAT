import type { SourceUploadValidation } from "./source-upload-transfers";
import { createHash, randomUUID } from "node:crypto";
import convertHeic from "heic-convert";
import { PDFDocument } from "pdf-lib";
import { isUuid, type AppClient, type Result } from "./client";
import { getCompany } from "./companies";
import { splitJob, type JobQueue } from "./processing";
import { assertWorkbookRanges, workbookToText } from "./workbooks";
import type { SourceRange } from "./ai-provider";

export type SourceFileFormat = "pdf" | "png" | "jpeg" | "heic" | "heif" | "xlsx" | "xls";
export type ImageSourceFileFormat = "pdf" | "png" | "jpeg" | "heic" | "heif";
export type SpreadsheetSourceFileFormat = "xlsx" | "xls";

/** Where the Split of a Source File stands; its Documents carry their own status. */
export type SourceFileStatus = "uploaded" | "waiting_for_platform" | "processing" | "split" | "failed" | "rejected" | "needs_review";

export type SourceFile = {
  id: string;
  companyId: string;
  fileName: string;
  format: SourceFileFormat;
  byteSize: number;
  sha256: string;
  storageAttemptId?: string;
  normalizedDerivative: {
    format: "jpeg";
    byteSize: number;
    sha256: string;
  } | null;
  pageCount: number;
  status: SourceFileStatus;
  uploadedAt: string;
  exclusion?: { reason: string; at: string; userId: string | null };
  manualDefinition?: { at: string; userId: string | null };
};

export type UploadSourceFileInput = {
  companyId: string;
  sourceFileId?: string;
  batchId?: string;
  fileName: string;
  bytes: Uint8Array;
};
export type UploadSourceFileError =
  | "file_required"
  | "file_too_large"
  | "too_many_pages"
  | "unsupported_format"
  | "content_does_not_match_format"
  | "unreadable_file"
  | "invalid_choice"
  | "identical_file"
  | "too_many_files"
  | "forbidden";

export const SOURCE_FILE_BUCKET = "source-files";

export const SOURCE_FILE_MEDIA_TYPES: Record<SourceFileFormat, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  heic: "image/heic",
  heif: "image/heif",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
};

const FORMAT_BY_EXTENSION: Record<string, SourceFileFormat> = {
  pdf: "pdf",
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  heic: "heic",
  heif: "heif",
  xlsx: "xlsx",
  xls: "xls",
};

// The bytes each format's content starts with.
const SIGNATURES: Record<SourceFileFormat, number[]> = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff],
  heic: [],
  heif: [],
  xlsx: [0x50, 0x4b, 0x03, 0x04],
  xls: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
};

export type UploadLimits = {
  maxFileBytes: number;
  maxFilePages: number;
  maxBatchFiles: number;
};

/** Public, non-secret platform limits applied to Source File uploads. */
export async function getUploadLimits(client: AppClient): Promise<UploadLimits> {
  const { data, error } = await client
    .from("platform_settings")
    .select("max_source_file_bytes, max_source_file_pages, max_upload_batch_files")
    .single();
  if (error) throw error;
  return {
    maxFileBytes: Number(data.max_source_file_bytes),
    maxFilePages: data.max_source_file_pages,
    maxBatchFiles: data.max_upload_batch_files,
  };
}

/** The format named by the file's extension. */
function formatOf(fileName: string): SourceFileFormat | null {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return FORMAT_BY_EXTENSION[extension] ?? null;
}

function contentMatches(format: SourceFileFormat, bytes: Uint8Array): boolean {
  if (format === "heic" || format === "heif") {
    if (String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp") return false;
    const brands = String.fromCharCode(...bytes.slice(8, Math.min(bytes.length, 40)));
    return ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]
      .some((brand) => brands.includes(brand));
  }
  return SIGNATURES[format].every((byte, i) => bytes[i] === byte);
}

export async function normalizedDerivative(
  format: SourceFileFormat,
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  if (format !== "heic" && format !== "heif") return null;
  try {
    return new Uint8Array(await convertHeic({ buffer: bytes, format: "JPEG", quality: 0.9 }));
  } catch {
    return null;
  }
}

async function countPages(format: SourceFileFormat, bytes: Uint8Array): Promise<number | null> {
  if (format === "xlsx" || format === "xls") {
    try {
      workbookToText(bytes);
      return 1;
    } catch {
      return null;
    }
  }
  if (format !== "pdf") return 1;
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return pdf.getPageCount() || null;
  } catch {
    return null;
  }
}

/** A PDF of just the given pages, 1-based and inclusive, of a PDF Source File. */
export async function pdfPages(bytes: Uint8Array, range: { firstPage: number; lastPage: number }): Promise<Uint8Array> {
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = await PDFDocument.create();
  const indices = Array.from({ length: range.lastPage - range.firstPage + 1 }, (_, i) => range.firstPage - 1 + i);
  for (const page of await pages.copyPages(source, indices)) pages.addPage(page);
  return pages.save();
}

export const sourceFileObjectPath = (companyId: string, sourceFileId: string, attemptId?: string | null) => attemptId ? `${companyId}/${sourceFileId}/transfer/${attemptId}/original` : `${companyId}/${sourceFileId}`;
export const sourceFileDerivativeObjectPath = (companyId: string, sourceFileId: string, attemptId?: string | null) =>
  attemptId ? `${companyId}/${sourceFileId}/transfer/${attemptId}/normalized.jpeg` : `${companyId}/${sourceFileId}/normalized.jpeg`;

/** A lost response or concurrent retry may leave the immutable object stored already. */
async function storeImmutableObject(
  client: AppClient,
  path: string,
  bytes: Uint8Array,
  contentType: string,
) {
  const { error } = await client.storage.from(SOURCE_FILE_BUCKET).upload(path, bytes, { contentType, upsert: false });
  if (!error || !("statusCode" in error) || error.statusCode !== "409") return error;
  const stored = await client.storage.from(SOURCE_FILE_BUCKET).download(path);
  if (stored.error) return stored.error;
  const storedHash = createHash("sha256").update(new Uint8Array(await stored.data.arrayBuffer())).digest("hex");
  return storedHash === createHash("sha256").update(bytes).digest("hex") ? null : error;
}

export type PreparedSourceFile = {
  fileName: string;
  format: SourceFileFormat;
  byteSize: number;
  pageCount: number;
  sha256: string;
};

/** Shared content validation for upload and later attachment of real originals. */
export async function prepareSourceFile(client: AppClient, input: { fileName: string; bytes: Uint8Array }): Promise<Result<PreparedSourceFile, UploadSourceFileError>> {
  return inspectSourceFile(input, await getUploadLimits(client));
}

/** Actual content inspection shared with the narrow trusted validator. */
export async function inspectSourceFile(input: { fileName: string; bytes: Uint8Array }, limits: UploadLimits): Promise<Result<PreparedSourceFile, UploadSourceFileError>> {
  const fileName = input.fileName.trim();
  if (!fileName || input.bytes.length === 0) return { ok: false, error: "file_required" };
  if (input.bytes.length > limits.maxFileBytes) return { ok: false, error: "file_too_large" };
  const format = formatOf(fileName);
  if (!format) return { ok: false, error: "unsupported_format" };
  if (!contentMatches(format, input.bytes)) return { ok: false, error: "content_does_not_match_format" };
  const pageCount = await countPages(format, input.bytes);
  if (!pageCount) return { ok: false, error: "unreadable_file" };
  if (pageCount > limits.maxFilePages) return { ok: false, error: "too_many_pages" };
  return { ok: true, value: { fileName, format, pageCount, byteSize: input.bytes.length, sha256: createHash("sha256").update(input.bytes).digest("hex") } };
}

/** Stores only immutable evidence. Recording/association and dispatch are separate. */
export async function storeSourceFileObjects(client: AppClient, input: { companyId: string; sourceFileId: string; format: SourceFileFormat; bytes: Uint8Array }): Promise<Result<{
  normalizedFormat: "jpeg" | null; normalizedByteSize: number | null; normalizedSha256: string | null;
}, UploadSourceFileError>> {
  const derivative = await normalizedDerivative(input.format, input.bytes);
  if ((input.format === "heic" || input.format === "heif") && !derivative) return { ok: false, error: "unreadable_file" };
  const storedError = await storeImmutableObject(client, sourceFileObjectPath(input.companyId, input.sourceFileId), input.bytes, SOURCE_FILE_MEDIA_TYPES[input.format]);
  if (storedError) {
    if ("statusCode" in storedError && storedError.statusCode === "403") return { ok: false, error: "forbidden" };
    if ("statusCode" in storedError && storedError.statusCode === "409") return { ok: false, error: "invalid_choice" };
    throw storedError;
  }
  if (derivative) {
    const error = await storeImmutableObject(client, sourceFileDerivativeObjectPath(input.companyId, input.sourceFileId), derivative, SOURCE_FILE_MEDIA_TYPES.jpeg);
    if (error) {
      if ("statusCode" in error && error.statusCode === "403") return { ok: false, error: "forbidden" };
      if ("statusCode" in error && error.statusCode === "409") return { ok: false, error: "invalid_choice" };
      throw error;
    }
  }
  return { ok: true, value: {
    normalizedFormat: derivative ? "jpeg" : null,
    normalizedByteSize: derivative?.length ?? null,
    normalizedSha256: derivative ? createHash("sha256").update(derivative).digest("hex") : null,
  } };
}

/**
 * Stores an uploaded file unchanged as a Source File of the Company. The file
 * is stored before its row is recorded (the database refuses a row without a
 * stored file), so a failed recording leaves only an unreferenced object.
 * Then the Split is enqueued; it runs once the Company has an enabled platform
 * AI Configuration assignment and remaining allowance.
 */
export async function uploadSourceFile(
  client: AppClient,
  jobs: JobQueue,
  input: UploadSourceFileInput,
  validator?: SourceUploadValidation,
): Promise<Result<{ id: string }, UploadSourceFileError>> {
  const fileName = input.fileName.trim();
  if (!fileName || input.bytes.length === 0) return { ok: false, error: "file_required" };
  if (input.sourceFileId !== undefined && !isUuid(input.sourceFileId)) {
    return { ok: false, error: "invalid_choice" };
  }
  if (input.batchId !== undefined && !isUuid(input.batchId)) return { ok: false, error: "forbidden" };
  const prepared = await prepareSourceFile(client, input);
  if (!prepared.ok) return prepared;
  const { format, pageCount, sha256 } = prepared.value;

  // Only for the Organization of the row; RLS hides Companies the user cannot access.
  const company = await getCompany(client, input.companyId);
  if (!company) return { ok: false, error: "forbidden" };

  const id = input.sourceFileId ?? randomUUID();
  const { data: existing, error: existingError } = await client
    .from("source_file")
    .select("id, upload_batch_id, file_name, format, byte_size, sha256")
    .eq("id", id)
    .eq("company_id", company.id)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    const matches = existing.upload_batch_id === (input.batchId ?? null)
      && existing.file_name === fileName
      && existing.format === format
      && Number(existing.byte_size) === input.bytes.length
      && existing.sha256 === sha256;
    if (!matches) return { ok: false, error: "invalid_choice" };
    await jobs.send(splitJob(existing.id));
    return { ok: true, value: { id: existing.id } };
  }

  const stored = await storeSourceFileObjects(client, { companyId: company.id, sourceFileId: id, format, bytes: input.bytes });
  if (!stored.ok) return stored;

  if (input.batchId) {
    if (!validator) return { ok: false, error: "forbidden" };
    const claim = await client.rpc("begin_source_file_validation", { target_company_id: company.id, target_batch_id: input.batchId, target_source_file_id: id,
      original_file_name: fileName, original_byte_size: input.bytes.length, original_sha256: sha256 });
    if (claim.error) {
      if (claim.error.code === "42501") return { ok: false, error: "forbidden" };
      if (claim.error.hint === "invalid_choice") return { ok: false, error: "invalid_choice" };
      throw claim.error;
    }
    const verified = await validator.validateAndStage(claim.data);
    if (!verified.ok) {
      const error = verified.error;
      if (error === "upload_incomplete" || error === "upload_checksum_mismatch") return { ok: false, error: "invalid_choice" };
      if (error === "upload_expired" || error === "upload_cancelled" || error === "upload_attempt_changed") return { ok: false, error: "forbidden" };
      return { ok: false, error };
    }
  }

  const { error } = await client.from("source_file").insert({
    id,
    organization_id: company.organizationId,
    company_id: company.id,
    upload_batch_id: input.batchId ?? null,
    file_name: fileName,
    format,
    byte_size: input.bytes.length,
    sha256,
    normalized_format: stored.value.normalizedFormat,
    normalized_byte_size: stored.value.normalizedByteSize,
    normalized_sha256: stored.value.normalizedSha256,
    page_count: pageCount,
  });
  if (error) {
    // A concurrent attempt can commit this same immutable identity first.
    const { data: recorded, error: readError } = await client.from("source_file")
      .select("id, upload_batch_id, file_name, format, byte_size, sha256")
      .eq("id", id).eq("company_id", company.id).maybeSingle();
    if (readError) throw readError;
    if (recorded && recorded.upload_batch_id === (input.batchId ?? null)
      && recorded.file_name === fileName && recorded.format === format
      && Number(recorded.byte_size) === input.bytes.length && recorded.sha256 === sha256) {
      await jobs.send(splitJob(id));
      return { ok: true, value: { id } };
    }
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.hint === "identical_file" || error.hint === "too_many_files" || error.hint === "invalid_choice" || error.hint === "file_too_large" || error.hint === "unsupported_format") return { ok: false, error: error.hint };
    throw error;
  }
  await jobs.send(splitJob(id));
  return { ok: true, value: { id } };
}

const COLUMNS = "storage_attempt_id, id, company_id, file_name, format, byte_size, sha256, normalized_format, normalized_byte_size, normalized_sha256, page_count, status, uploaded_at, exclusion_reason, excluded_at, excluded_by, manually_defined_at, manually_defined_by";

type SourceFileRow = {
  storage_attempt_id: string | null;
  id: string;
  company_id: string;
  file_name: string;
  format: SourceFileFormat;
  byte_size: number;
  sha256: string;
  normalized_format: SourceFileFormat | null;
  normalized_byte_size: number | null;
  normalized_sha256: string | null;
  page_count: number;
  status: SourceFileStatus;
  uploaded_at: string;
  exclusion_reason: string | null;
  excluded_at: string | null;
  excluded_by: string | null;
  manually_defined_at: string | null;
  manually_defined_by: string | null;
};

function toSourceFile(row: SourceFileRow): SourceFile {
  return {
    ...(row.storage_attempt_id ? { storageAttemptId: row.storage_attempt_id } : {}),
    id: row.id,
    companyId: row.company_id,
    fileName: row.file_name,
    format: row.format,
    byteSize: row.byte_size,
    sha256: row.sha256,
    normalizedDerivative:
      row.normalized_format === "jpeg" && row.normalized_byte_size && row.normalized_sha256
        ? {
            format: row.normalized_format,
            byteSize: Number(row.normalized_byte_size),
            sha256: row.normalized_sha256,
          }
        : null,
    pageCount: row.page_count,
    status: row.status,
    uploadedAt: row.uploaded_at,
    ...(row.exclusion_reason && row.excluded_at ? { exclusion: { reason: row.exclusion_reason, at: row.excluded_at, userId: row.excluded_by } } : {}),
    ...(row.manually_defined_at ? { manualDefinition: { at: row.manually_defined_at, userId: row.manually_defined_by } } : {}),
  };
}

/** Source Files of a Company, newest first. */
export async function listSourceFiles(client: AppClient, companyId: string): Promise<SourceFile[]> {
  const { data, error } = await client
    .from("source_file")
    .select(COLUMNS)
    .eq("company_id", companyId)
    .order("uploaded_at", { ascending: false })
    .order("id");
  if (error) throw error;
  return data.map(toSourceFile);
}

/** A Source File of the Company, or null when the Company has none with that id. */
export async function getSourceFile(
  client: AppClient,
  companyId: string,
  sourceFileId: string,
): Promise<SourceFile | null> {
  if (!isUuid(companyId) || !isUuid(sourceFileId)) return null;
  const { data, error } = await client
    .from("source_file")
    .select(COLUMNS)
    .eq("company_id", companyId)
    .eq("id", sourceFileId)
    .maybeSingle();
  if (error) throw error;
  return data && toSourceFile(data);
}

/** A Source File with its stored content, exactly as uploaded. */
export async function readSourceFile(
  client: AppClient,
  companyId: string,
  sourceFileId: string,
): Promise<{ file: SourceFile; bytes: Uint8Array } | null> {
  const file = await getSourceFile(client, companyId, sourceFileId);
  if (!file) return null;
  const { data, error } = await client.storage.from(SOURCE_FILE_BUCKET).download(sourceFileObjectPath(file.companyId, file.id, file.storageAttemptId));
  if (error) throw error;
  return { file, bytes: new Uint8Array(await data.arrayBuffer()) };
}

/** The normalized preview/AI derivative, explicitly linked to its immutable original. */
export async function readSourceFileDerivative(
  client: AppClient,
  companyId: string,
  sourceFileId: string,
): Promise<{
  sourceFileId: string;
  originalSha256: string;
  format: "jpeg";
  sha256: string;
  bytes: Uint8Array;
} | null> {
  const file = await getSourceFile(client, companyId, sourceFileId);
  if (!file?.normalizedDerivative) return null;
  const { data, error } = await client.storage
    .from(SOURCE_FILE_BUCKET)
    .download(sourceFileDerivativeObjectPath(file.companyId, file.id, file.storageAttemptId));
  if (error) throw error;
  return {
    sourceFileId: file.id,
    originalSha256: file.sha256,
    format: file.normalizedDerivative.format,
    sha256: file.normalizedDerivative.sha256,
    bytes: new Uint8Array(await data.arrayBuffer()),
  };
}

/** Runs the Split of a Source File again after it failed. */
export async function retrySplit(
  client: AppClient,
  jobs: JobQueue,
  input: { companyId: string; sourceFileId: string },
): Promise<Result<null, "not_retryable" | "forbidden" | "period_locked" | "source_already_resolved">> {
  const file = await getSourceFile(client, input.companyId, input.sourceFileId);
  if (!file) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("retry_split", { target_source_file_id: file.id });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    for (const refusal of ["not_retryable", "period_locked", "source_already_resolved"] as const) {
      if (error.code === "P0001" && error.hint === refusal) return { ok: false, error: refusal };
    }
    throw error;
  }
  await jobs.send(splitJob(file.id));
  return { ok: true, value: null };
}


/** Defines actual page or worksheet boundaries for manual review without starting AI. */
export async function defineSourceDocuments(
  client: AppClient,
  input: { companyId: string; sourceFileId: string; ranges: SourceRange[] },
): Promise<Result<{ documentIds: string[] }, "forbidden" | "source_already_resolved" | "manual_source_format_unsupported" | "invalid_source_ranges" | "invalid_workbook_ranges" | "period_locked">> {
  const file = await getSourceFile(client, input.companyId, input.sourceFileId);
  if (!file) return { ok: false, error: "forbidden" };
  if (file.format === "xlsx" || file.format === "xls") {
    const workbook = await readSourceWorkbook(client, input.companyId, file.id);
    if (!workbook) return { ok: false, error: "forbidden" };
    try { assertWorkbookRanges(workbook.rowSets, input.ranges); }
    catch { return { ok: false, error: "invalid_workbook_ranges" }; }
  }
  const { data, error } = await client.rpc("define_source_documents", { target_source_file_id: file.id, document_ranges: input.ranges });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.code === "P0001" && error.hint === "invalid_source_ranges" && (file.format === "xlsx" || file.format === "xls")) return { ok: false, error: "invalid_workbook_ranges" };
    for (const refusal of ["source_already_resolved", "manual_source_format_unsupported", "invalid_source_ranges", "period_locked"] as const) {
      if (error.code === "P0001" && error.hint === refusal) return { ok: false, error: refusal };
    }
    throw error;
  }
  return { ok: true, value: { documentIds: data } };
}

/** Actual worksheet names, bounds and row-numbered text from the unchanged original. */
export async function readSourceWorkbook(client: AppClient, companyId: string, sourceFileId: string) {
  const stored = await readSourceFile(client, companyId, sourceFileId);
  if (!stored || (stored.file.format !== "xlsx" && stored.file.format !== "xls")) return null;
  return workbookToText(stored.bytes);
}


export type SourceRecoveryError = "forbidden" | "source_already_resolved" | "exclusion_reason_required" | "source_not_rejected" | "period_locked";

/** Cancels pending Split work so the User can define actual boundaries. */
export async function startManualSourceReview(client: AppClient, input: { companyId: string; sourceFileId: string }): Promise<Result<null, SourceRecoveryError>> {
  return sourceRecoveryCommand(client, input, "start_manual_source_review");
}

/** Resolves a Source before any Document exists, preserving its bytes and reason. */
export async function excludeSourceFile(client: AppClient, input: { companyId: string; sourceFileId: string; reason: string }): Promise<Result<null, SourceRecoveryError>> {
  return sourceRecoveryCommand(client, input, "exclude_source_file", input.reason);
}

/** Reversal returns to manual review; starting AI remains an explicit choice. */
export async function restoreSourceFile(client: AppClient, input: { companyId: string; sourceFileId: string }): Promise<Result<null, SourceRecoveryError>> {
  return sourceRecoveryCommand(client, input, "restore_source_file");
}

async function sourceRecoveryCommand(client: AppClient, input: { companyId: string; sourceFileId: string }, command: "start_manual_source_review" | "exclude_source_file" | "restore_source_file", reason?: string): Promise<Result<null, SourceRecoveryError>> {
  const file = await getSourceFile(client, input.companyId, input.sourceFileId);
  if (!file) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc(command, { target_source_file_id: file.id, ...(command === "exclude_source_file" ? { exclusion_reason: reason } : {}) });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    for (const refusal of ["source_already_resolved", "exclusion_reason_required", "source_not_rejected", "period_locked"] as const) {
      if (error.code === "P0001" && error.hint === refusal) return { ok: false, error: refusal };
    }
    throw error;
  }
  return { ok: true, value: null };
}


/** A Source lock comes only from an existing locked readiness snapshot. */
export async function sourceFilePeriodLock(client: AppClient, companyId: string, sourceFileId: string): Promise<string | null> {
  const file = await getSourceFile(client, companyId, sourceFileId);
  if (!file) return null;
  const { data, error } = await client.rpc("source_file_period_lock", { target_source_file_id: file.id });
  if (error) throw error;
  return data;
}
