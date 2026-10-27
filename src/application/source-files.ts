import { createHash, randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { isUuid, type AppClient, type Result } from "./client";
import { getCompany } from "./companies";
import { splitJob, type JobQueue } from "./processing";

export type SourceFileFormat = "pdf" | "png" | "jpeg";

/** Where the Split of a Source File stands; its Documents carry their own status. */
export type SourceFileStatus = "uploaded" | "processing" | "split" | "failed";

export type SourceFile = {
  id: string;
  companyId: string;
  fileName: string;
  format: SourceFileFormat;
  byteSize: number;
  sha256: string;
  pageCount: number;
  status: SourceFileStatus;
  uploadedAt: string;
};

export type UploadSourceFileInput = { companyId: string; fileName: string; bytes: Uint8Array };
export type UploadSourceFileError =
  | "file_required"
  | "unsupported_format"
  | "content_does_not_match_format"
  | "unreadable_file"
  | "forbidden";

export const SOURCE_FILE_BUCKET = "source-files";

export const SOURCE_FILE_MEDIA_TYPES: Record<SourceFileFormat, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
};

const FORMAT_BY_EXTENSION: Record<string, SourceFileFormat> = { pdf: "pdf", png: "png", jpg: "jpeg", jpeg: "jpeg" };

// The bytes each format's content starts with.
const SIGNATURES: Record<SourceFileFormat, number[]> = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff],
};

/** The format named by the file's extension. */
function formatOf(fileName: string): SourceFileFormat | null {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return FORMAT_BY_EXTENSION[extension] ?? null;
}

function contentMatches(format: SourceFileFormat, bytes: Uint8Array): boolean {
  return SIGNATURES[format].every((byte, i) => bytes[i] === byte);
}

async function countPages(format: SourceFileFormat, bytes: Uint8Array): Promise<number | null> {
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

/**
 * Stores an uploaded file unchanged as a Source File of the Company. The file
 * is stored before its row is recorded (the database refuses a row without a
 * stored file), so a failed recording leaves only an unreferenced object.
 * Then the Split is enqueued; it runs once the Company enables AI processing.
 */
export async function uploadSourceFile(
  client: AppClient,
  jobs: JobQueue,
  input: UploadSourceFileInput,
): Promise<Result<{ id: string }, UploadSourceFileError>> {
  const fileName = input.fileName.trim();
  if (!fileName || input.bytes.length === 0) return { ok: false, error: "file_required" };
  const format = formatOf(fileName);
  if (!format) return { ok: false, error: "unsupported_format" };
  if (!contentMatches(format, input.bytes)) return { ok: false, error: "content_does_not_match_format" };
  const pageCount = await countPages(format, input.bytes);
  if (!pageCount) return { ok: false, error: "unreadable_file" };

  // Only for the Organization of the row; RLS hides Companies the user cannot access.
  const company = await getCompany(client, input.companyId);
  if (!company) return { ok: false, error: "forbidden" };

  const id = randomUUID();
  const stored = await client.storage
    .from(SOURCE_FILE_BUCKET)
    .upload(sourceFileObjectPath(company.id, id), input.bytes, { contentType: SOURCE_FILE_MEDIA_TYPES[format], upsert: false });
  if (stored.error) {
    if ("statusCode" in stored.error && stored.error.statusCode === "403") return { ok: false, error: "forbidden" };
    throw stored.error;
  }

  const { error } = await client.from("source_file").insert({
    id,
    organization_id: company.organizationId,
    company_id: company.id,
    file_name: fileName,
    format,
    byte_size: input.bytes.length,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    page_count: pageCount,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  await jobs.send(splitJob(id));
  return { ok: true, value: { id } };
}

const COLUMNS = "id, company_id, file_name, format, byte_size, sha256, page_count, status, uploaded_at";

type SourceFileRow = {
  id: string;
  company_id: string;
  file_name: string;
  format: SourceFileFormat;
  byte_size: number;
  sha256: string;
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
