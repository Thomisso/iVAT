import { createHash, randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { AppClient, Result } from "./client";
import { getCompany } from "./companies";

export type SourceFileFormat = "pdf" | "png" | "jpeg";

export type SourceFile = {
  id: string;
  companyId: string;
  fileName: string;
  format: SourceFileFormat;
  byteSize: number;
  sha256: string;
  pageCount: number;
  uploadedAt: string;
};

export type UploadSourceFileInput = { companyId: string; fileName: string; bytes: Uint8Array };
export type UploadSourceFileError =
  | "file_required"
  | "unsupported_format"
  | "content_does_not_match_format"
  | "unreadable_file"
  | "forbidden";

const BUCKET = "source-files";

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

const objectPath = (companyId: string, sourceFileId: string) => `${companyId}/${sourceFileId}`;

/**
 * Stores an uploaded file unchanged as a Source File of the Company. The file
 * is stored before its row is recorded (the database refuses a row without a
 * stored file), so a failed recording leaves only an unreferenced object.
 */
export async function uploadSourceFile(
  client: AppClient,
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
    .from(BUCKET)
    .upload(objectPath(company.id, id), input.bytes, { contentType: SOURCE_FILE_MEDIA_TYPES[format], upsert: false });
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
  return { ok: true, value: { id } };
}

const COLUMNS = "id, company_id, file_name, format, byte_size, sha256, page_count, uploaded_at";

type SourceFileRow = {
  id: string;
  company_id: string;
  file_name: string;
  format: SourceFileFormat;
  byte_size: number;
  sha256: string;
  page_count: number;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Source File of the Company, or null when the Company has none with that id. */
export async function getSourceFile(
  client: AppClient,
  companyId: string,
  sourceFileId: string,
): Promise<SourceFile | null> {
  if (!UUID.test(companyId) || !UUID.test(sourceFileId)) return null;
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
  const { data, error } = await client.storage.from(BUCKET).download(objectPath(file.companyId, file.id));
  if (error) throw error;
  return { file, bytes: new Uint8Array(await data.arrayBuffer()) };
}
