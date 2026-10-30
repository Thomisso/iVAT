import { createHash, randomUUID } from "node:crypto";
import convertHeic from "heic-convert";
import { PDFDocument } from "pdf-lib";
import { isUuid, type AppClient, type Result } from "./client";
import { getCompany } from "./companies";
import { splitJob, type JobQueue } from "./processing";
import { workbookToText } from "./workbooks";

export type SourceFileFormat = "pdf" | "png" | "jpeg" | "heic" | "heif" | "xlsx" | "xls";
export type ImageSourceFileFormat = "pdf" | "png" | "jpeg" | "heic" | "heif";
export type SpreadsheetSourceFileFormat = "xlsx" | "xls";

/** Where the Split of a Source File stands; its Documents carry their own status. */
export type SourceFileStatus = "uploaded" | "waiting_for_platform" | "processing" | "split" | "failed";

export type SourceFile = {
  id: string;
  companyId: string;
  fileName: string;
  format: SourceFileFormat;
  byteSize: number;
  sha256: string;
  normalizedDerivative: {
    format: "jpeg";
    byteSize: number;
    sha256: string;
  } | null;
  pageCount: number;
  status: SourceFileStatus;
  uploadedAt: string;
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

async function normalizedDerivative(
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

export const sourceFileObjectPath = (companyId: string, sourceFileId: string) => `${companyId}/${sourceFileId}`;
export const sourceFileDerivativeObjectPath = (companyId: string, sourceFileId: string) =>
  `${companyId}/${sourceFileId}/normalized.jpeg`;

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
): Promise<Result<{ id: string }, UploadSourceFileError>> {
  const fileName = input.fileName.trim();
  if (!fileName || input.bytes.length === 0) return { ok: false, error: "file_required" };
  if (input.sourceFileId !== undefined && !isUuid(input.sourceFileId)) {
    return { ok: false, error: "invalid_choice" };
  }
  if (input.batchId !== undefined && !isUuid(input.batchId)) return { ok: false, error: "forbidden" };
  const limits = await getUploadLimits(client);
  if (input.bytes.length > limits.maxFileBytes) return { ok: false, error: "file_too_large" };
  const format = formatOf(fileName);
  if (!format) return { ok: false, error: "unsupported_format" };
  if (!contentMatches(format, input.bytes)) return { ok: false, error: "content_does_not_match_format" };
  const pageCount = await countPages(format, input.bytes);
  if (!pageCount) return { ok: false, error: "unreadable_file" };
  if (pageCount > limits.maxFilePages) return { ok: false, error: "too_many_pages" };
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");

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

  const derivative = await normalizedDerivative(format, input.bytes);
  if ((format === "heic" || format === "heif") && !derivative) {
    return { ok: false, error: "unreadable_file" };
  }
  const storedError = await storeImmutableObject(client, sourceFileObjectPath(company.id, id), input.bytes, SOURCE_FILE_MEDIA_TYPES[format]);
  if (storedError) {
    if ("statusCode" in storedError && storedError.statusCode === "403") return { ok: false, error: "forbidden" };
    if ("statusCode" in storedError && storedError.statusCode === "409") return { ok: false, error: "invalid_choice" };
    throw storedError;
  }
  if (derivative) {
    const derivativeError = await storeImmutableObject(client, sourceFileDerivativeObjectPath(company.id, id), derivative, SOURCE_FILE_MEDIA_TYPES.jpeg);
    if (derivativeError) throw derivativeError;
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
    normalized_format: derivative ? "jpeg" : null,
    normalized_byte_size: derivative?.length ?? null,
    normalized_sha256: derivative
      ? createHash("sha256").update(derivative).digest("hex")
      : null,
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
    if (error.hint === "identical_file" || error.hint === "too_many_files" || error.hint === "invalid_choice") return { ok: false, error: error.hint };
    throw error;
  }
  await jobs.send(splitJob(id));
  return { ok: true, value: { id } };
}

const COLUMNS = "id, company_id, file_name, format, byte_size, sha256, normalized_format, normalized_byte_size, normalized_sha256, page_count, status, uploaded_at";

type SourceFileRow = {
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
};

function toSourceFile(row: SourceFileRow): SourceFile {
  return {
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
  const { data, error } = await client.storage.from(SOURCE_FILE_BUCKET).download(sourceFileObjectPath(file.companyId, file.id));
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
    .download(sourceFileDerivativeObjectPath(file.companyId, file.id));
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
): Promise<Result<null, "not_retryable" | "forbidden">> {
  const file = await getSourceFile(client, input.companyId, input.sourceFileId);
  if (!file) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("retry_split", { target_source_file_id: file.id });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.hint === "not_retryable") return { ok: false, error: "not_retryable" };
    throw error;
  }
  await jobs.send(splitJob(file.id));
  return { ok: true, value: null };
}
