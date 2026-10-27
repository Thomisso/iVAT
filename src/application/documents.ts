import { isUuid, type AppClient, type Result } from "./client";
import type { ExtractionPayload } from "./extraction-payload";
import { extractJob, type JobQueue } from "./processing";

export type DocumentStatus = "uploaded" | "processing" | "needs_review" | "failed";

export type Document = {
  id: string;
  companyId: string;
  sourceFileId: string;
  firstPage: number;
  lastPage: number;
  status: DocumentStatus;
  createdAt: string;
};

export type ExtractionVersionAuthor = { kind: "ai"; provider: string; model: string } | { kind: "user"; userId: string };

export type ExtractionVersion = {
  id: string;
  documentId: string;
  version: number;
  author: ExtractionVersionAuthor;
  payload: ExtractionPayload;
  createdAt: string;
};

/** The Documents a Source File of the Company was Split into, in page order. */
export async function listDocuments(client: AppClient, companyId: string, sourceFileId: string): Promise<Document[]> {
  if (!isUuid(companyId) || !isUuid(sourceFileId)) return [];
  const { data, error } = await client
    .from("document")
    .select("id, company_id, source_file_id, first_page, last_page, status, created_at")
    .eq("company_id", companyId)
    .eq("source_file_id", sourceFileId)
    .order("first_page");
  if (error) throw error;
  return data.map((d) => ({
    id: d.id,
    companyId: d.company_id,
    sourceFileId: d.source_file_id,
    firstPage: d.first_page,
    lastPage: d.last_page,
    status: d.status,
    createdAt: d.created_at,
  }));
}

/** A Document's Extraction Versions, oldest first; the last one is its current data. */
export async function listExtractionVersions(
  client: AppClient,
  companyId: string,
  documentId: string,
): Promise<ExtractionVersion[]> {
  if (!isUuid(companyId) || !isUuid(documentId)) return [];
  const { data, error } = await client
    .from("extraction_version")
    .select("id, document_id, version, provider, model, author_user_id, payload, created_at")
    .eq("company_id", companyId)
    .eq("document_id", documentId)
    .order("version");
  if (error) throw error;
  return data.map((v) => ({
    id: v.id,
    documentId: v.document_id,
    version: v.version,
    author: v.author_user_id
      ? { kind: "user", userId: v.author_user_id }
      : { kind: "ai", provider: v.provider!, model: v.model! },
    payload: v.payload as ExtractionPayload,
    createdAt: v.created_at,
  }));
}

/**
 * Runs Extraction of a Document again: a retry after it failed, or a reprocess
 * after review. The run adds a new Extraction Version; earlier ones are kept.
 */
export async function reprocessDocument(
  client: AppClient,
  jobs: JobQueue,
  input: { companyId: string; documentId: string },
): Promise<Result<null, "not_reprocessable" | "forbidden">> {
  if (!isUuid(input.companyId) || !isUuid(input.documentId)) return { ok: false, error: "forbidden" };
  const { data: document, error: readError } = await client
    .from("document")
    .select("id")
    .eq("company_id", input.companyId)
    .eq("id", input.documentId)
    .maybeSingle();
  if (readError) throw readError;
  if (!document) return { ok: false, error: "forbidden" };

  const { error } = await client.rpc("reprocess_document", { target_document_id: document.id });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.hint === "not_reprocessable") return { ok: false, error: "not_reprocessable" };
    throw error;
  }
  await jobs.send(extractJob(document.id));
  return { ok: true, value: null };
}
