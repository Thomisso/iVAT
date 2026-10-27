import type { PostgrestError } from "@supabase/supabase-js";
import { isUuid, type AppClient, type Result } from "./client";
import {
  validateExtractionPayload,
  type Direction,
  type ExtractionPayload,
  type ExtractionPayloadError,
} from "./extraction-payload";
import { extractJob, type JobQueue } from "./processing";
import { pdfPages, readSourceFile, SOURCE_FILE_MEDIA_TYPES } from "./source-files";

export type DocumentStatus = "uploaded" | "processing" | "needs_review" | "approved" | "rejected" | "failed";

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

/** Only Approved Documents count towards VAT Reports (ADR-0003). */
export const isEligibleForVatReport = (status: DocumentStatus) => status === "approved";

/** A Document as the Document list shows it: with the fields of its current Extraction Version. */
export type DocumentOverview = {
  id: string;
  sourceFileId: string;
  firstPage: number;
  lastPage: number;
  status: DocumentStatus;
  createdAt: string;
  /** The current Extraction Version; null until the first Extraction. */
  version: number | null;
  documentNumber: string | null;
  direction: Direction | null;
  taxPointDate: string | null;
  /** The month of the Tax Point Date, "2026-10", until Receipt Dates and quarterly periods exist (#43). */
  reportingPeriod: string | null;
  /** The supplier of an incoming Document, the customer of an outgoing one; null while the Direction is unknown. */
  counterparty: { name: string | null; vatId: string | null; ico: string | null } | null;
  currency: string | null;
  grossAmount: string | null;
  eligibleForVatReport: boolean;
};

export type DocumentFilters = {
  status?: DocumentStatus;
  direction?: Direction;
  /** A month, "2026-10". */
  reportingPeriod?: string;
  /** Part of the counterparty's name, VAT ID or IČO, in any case. */
  counterparty?: string;
};

/** Escapes the characters LIKE treats specially, so a search term matches literally. */
const likeLiteral = (term: string) => term.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The Company's Documents, newest first, narrowed by the filters. */
export async function listCompanyDocuments(
  client: AppClient,
  companyId: string,
  filters: DocumentFilters = {},
): Promise<DocumentOverview[]> {
  if (!isUuid(companyId)) return [];
  let query = client
    .from("document_overview")
    .select(
      "id, source_file_id, first_page, last_page, status, created_at, version, document_number, direction, tax_point_date, reporting_period, counterparty_name, counterparty_vat_id, counterparty_ico, currency, gross_amount",
    )
    .eq("company_id", companyId);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.direction) query = query.eq("direction", filters.direction);
  if (filters.reportingPeriod) query = query.eq("reporting_period", filters.reportingPeriod);
  const counterparty = filters.counterparty?.trim();
  if (counterparty) query = query.ilike("counterparty_search", `%${likeLiteral(counterparty)}%`);

  const { data, error } = await query.order("created_at", { ascending: false }).order("first_page");
  if (error) throw error;
  return data.map((d) => ({
    id: d.id,
    sourceFileId: d.source_file_id,
    firstPage: d.first_page,
    lastPage: d.last_page,
    status: d.status,
    createdAt: d.created_at,
    version: d.version,
    documentNumber: d.document_number,
    direction: d.direction as Direction | null,
    taxPointDate: d.tax_point_date,
    reportingPeriod: d.reporting_period,
    counterparty:
      d.direction === null ? null : { name: d.counterparty_name, vatId: d.counterparty_vat_id, ico: d.counterparty_ico },
    currency: d.currency,
    grossAmount: d.gross_amount,
    eligibleForVatReport: isEligibleForVatReport(d.status),
  }));
}

const DOCUMENT_COLUMNS = "id, company_id, source_file_id, first_page, last_page, status, created_at";

function toDocument(d: {
  id: string;
  company_id: string;
  source_file_id: string;
  first_page: number;
  last_page: number;
  status: DocumentStatus;
  created_at: string;
}): Document {
  return {
    id: d.id,
    companyId: d.company_id,
    sourceFileId: d.source_file_id,
    firstPage: d.first_page,
    lastPage: d.last_page,
    status: d.status,
    createdAt: d.created_at,
  };
}

/** The Documents a Source File of the Company was Split into, in page order. */
export async function listDocuments(client: AppClient, companyId: string, sourceFileId: string): Promise<Document[]> {
  if (!isUuid(companyId) || !isUuid(sourceFileId)) return [];
  const { data, error } = await client
    .from("document")
    .select(DOCUMENT_COLUMNS)
    .eq("company_id", companyId)
    .eq("source_file_id", sourceFileId)
    .order("first_page");
  if (error) throw error;
  return data.map(toDocument);
}

/** A Document of the Company, or null when the Company has none with that id. */
export async function getDocument(client: AppClient, companyId: string, documentId: string): Promise<Document | null> {
  if (!isUuid(companyId) || !isUuid(documentId)) return null;
  const { data, error } = await client
    .from("document")
    .select(DOCUMENT_COLUMNS)
    .eq("company_id", companyId)
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  return data && toDocument(data);
}

/**
 * The original of a Document for the review workspace: the pages of its Source
 * File that it spans, as a PDF of just those pages, or the image as uploaded.
 */
export async function readDocumentPages(
  client: AppClient,
  companyId: string,
  documentId: string,
): Promise<{ fileName: string; mediaType: string; bytes: Uint8Array } | null> {
  const document = await getDocument(client, companyId, documentId);
  if (!document) return null;
  const stored = await readSourceFile(client, companyId, document.sourceFileId);
  if (!stored) return null;
  const { file, bytes } = stored;
  return {
    fileName: file.fileName,
    mediaType: SOURCE_FILE_MEDIA_TYPES[file.format],
    bytes: file.format === "pdf" ? await pdfPages(bytes, document) : bytes,
  };
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

export type CorrectDocumentError = ExtractionPayloadError | "not_in_review" | "stale_version" | "forbidden";

/**
 * Saves a User's corrections of a Document in review as its next Extraction
 * Version (ADR-0005), authored by them. `basedOnVersion` is the version the
 * corrections start from; they are refused if a newer one has been recorded.
 * The provider's confidence describes its own reading, so it is not carried over.
 */
export async function correctDocument(
  client: AppClient,
  input: { companyId: string; documentId: string; basedOnVersion: number; payload: ExtractionPayload },
): Promise<Result<{ version: number }, CorrectDocumentError>> {
  const invalid = validateExtractionPayload(input.payload);
  if (invalid) return { ok: false, error: invalid };
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const payload = { ...input.payload };
  delete payload.confidence;

  const { data: version, error } = await client.rpc("correct_document", {
    target_document_id: document,
    based_on_version: input.basedOnVersion,
    payload,
  });
  if (error) return refusal(error, ["not_in_review", "stale_version"]);
  return { ok: true, value: { version } };
}

/**
 * Approves a Document in review: a human confirms its current data, which then
 * counts towards VAT Reports (ADR-0003). `version` is the Extraction Version the
 * User reviewed; it is refused if a newer one has been recorded.
 */
export async function approveDocument(
  client: AppClient,
  input: { companyId: string; documentId: string; version: number },
): Promise<Result<null, "not_in_review" | "stale_version" | "forbidden">> {
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("approve_document", { target_document_id: document, reviewed_version: input.version });
  if (error) return refusal(error, ["not_in_review", "stale_version"]);
  return { ok: true, value: null };
}

/** Rejects a Document in review, excluding it from VAT Reports and the review queue. */
export async function rejectDocument(
  client: AppClient,
  input: { companyId: string; documentId: string },
): Promise<Result<null, "not_in_review" | "forbidden">> {
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("reject_document", { target_document_id: document });
  if (error) return refusal(error, ["not_in_review"]);
  return { ok: true, value: null };
}

/** The id of a Document of the Company the user can see, or null. */
async function findDocumentId(client: AppClient, companyId: string, documentId: string): Promise<string | null> {
  if (!isUuid(companyId) || !isUuid(documentId)) return null;
  const { data, error } = await client
    .from("document")
    .select("id")
    .eq("company_id", companyId)
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/** Maps a review function's refusal to its code; anything else is unexpected and thrown. */
function refusal<E extends string>(error: PostgrestError, codes: E[]): { ok: false; error: E | "forbidden" } {
  if (error.code === "42501") return { ok: false, error: "forbidden" };
  const code = codes.find((c) => c === error.hint);
  if (code) return { ok: false, error: code };
  throw error;
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
