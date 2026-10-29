import type { PostgrestError } from "@supabase/supabase-js";
import { isUuid, type AppClient, type Result } from "./client";
import {
  normalizeExtractionPayload,
  validateExtractionPayload,
  type Direction,
  type Party,
  type ExtractionPayload,
  type ExtractionPayloadError,
} from "./extraction-payload";
import { extractJob, type JobQueue } from "./processing";
import {
  CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA,
  validateDocument,
  type ValidationFinding,
} from "./document-validation";
import { pdfPages, readSourceFile, SOURCE_FILE_MEDIA_TYPES } from "./source-files";
import { workbookRowsToText, type WorkbookRowSet } from "./workbooks";
import { applyCnbConversion, type ExchangeRateProvider } from "./exchange-rates";

const unavailableExchangeRates: ExchangeRateProvider = { rateFor: async () => null };

export const DOCUMENT_STATUSES = ["uploaded", "processing", "needs_review", "approved", "rejected", "failed"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Whether Extraction of the Document is still to run or running. */
export const isBeingExtracted = (status: DocumentStatus) => status === "uploaded" || status === "processing";

export type Document = {
  id: string;
  companyId: string;
  sourceFileId: string;
  firstPage: number;
  lastPage: number;
  status: DocumentStatus;
  createdAt: string;
  /** Defaults to the Source File upload date and determines an incoming claim's earliest period. */
  receiptDate: string;
  /** A User's explicit move of input VAT to a later Reporting Period. */
  claimedReportingPeriod: string | null;
  /** Present only for a Document identified by workbook rows instead of pages. */
  rowSet?: WorkbookRowSet;
  /** Present and false for row-based Documents, which have no page image. */
  hasDocumentImage?: false;
};

export type ExtractionVersionAuthor =
  { kind: "ai"; provider: string; model: string } | { kind: "user"; userId: string };

export type ExtractionVersion = {
  id: string;
  documentId: string;
  version: number;
  author: ExtractionVersionAuthor;
  payload: ExtractionPayload;
  findings: ValidationFinding[];
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
  receiptDate: string;
  claimedReportingPeriod: string | null;
  reportingPeriod: string | null;
  /** The supplier of an incoming Document, the customer of an outgoing one; null while the Direction is unknown. */
  counterparty: Pick<Party, "name" | "vatId" | "ico"> | null;
  currency: string | null;
  grossAmount: string | null;
  findingCount: number;
  eligibleForVatReport: boolean;
};

export type DuplicateWarning = {
  kind: "document_identity" | "source_file_hash";
  matchedDocumentId: string;
};

/**
 * A Document's Duplicate Warning, if it matches an earlier Document in the
 * same Company. The warning is informational and never affects approval.
 */
export async function listDuplicateWarnings(
  client: AppClient,
  companyId: string,
  documentId: string,
): Promise<DuplicateWarning[]> {
  if (!isUuid(companyId) || !isUuid(documentId)) return [];
  const { data, error } = await client
    .from("document_duplicate_warning")
    .select("matched_document_id, kind")
    .eq("company_id", companyId)
    .eq("document_id", documentId);
  if (error) throw error;
  return data.map((warning) => ({
    kind: warning.kind as DuplicateWarning["kind"],
    matchedDocumentId: warning.matched_document_id!,
  }));
}

export type DocumentFilters = {
  status?: DocumentStatus;
  direction?: Direction;
  /** Source Files that define a durable upload-batch or queue context. */
  sourceFileIds?: string[];
  /** A month, "2026-10". */
  reportingPeriod?: string;
  /** Part of the counterparty's name, VAT ID or IČO, in any case. */
  counterparty?: string;
  hasFindings?: boolean;
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
  if (filters.sourceFileIds?.length === 0) return [];
  const counterparty = filters.counterparty?.trim();
  const documents: DocumentOverview[] = [];
  for (let from = 0; ; from += 1000) {
    let query = client
      .from("document_overview")
      .select(
        "id, source_file_id, first_page, last_page, status, created_at, version, document_number, direction, tax_point_date, receipt_date, claimed_reporting_period, reporting_period, counterparty_name, counterparty_vat_id, counterparty_ico, currency, gross_amount, finding_count",
      )
      .eq("company_id", companyId);
    if (filters.sourceFileIds) query = query.in("source_file_id", filters.sourceFileIds);
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.direction) query = query.eq("direction", filters.direction);
    if (filters.reportingPeriod) query = query.eq("reporting_period", filters.reportingPeriod);
    if (counterparty) query = query.ilike("counterparty_search", `%${likeLiteral(counterparty)}%`);
    if (filters.hasFindings) query = query.gt("finding_count", 0);

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("first_page")
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    documents.push(...data.map((d) => ({
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
      receiptDate: d.receipt_date,
      claimedReportingPeriod: d.claimed_reporting_period,
      reportingPeriod: d.reporting_period,
      counterparty: d.direction === null
        ? null
        : { name: d.counterparty_name, vatId: d.counterparty_vat_id, ico: d.counterparty_ico },
      currency: d.currency,
      grossAmount: d.gross_amount,
      findingCount: d.finding_count ?? 0,
      eligibleForVatReport: isEligibleForVatReport(d.status),
    })));
    if (data.length < 1000) return documents;
  }
}

/** Active Reporting Period locks for Documents, keyed by Document id. */
export async function documentPeriodLocks(
  client: AppClient,
  companyId: string,
  documentIds: string[],
): Promise<Record<string, string>> {
  if (!isUuid(companyId) || documentIds.length === 0 || documentIds.some((id) => !isUuid(id))) return {};
  const documents: { id: string; reporting_period: string | null }[] = [];
  const uniqueDocumentIds = [...new Set(documentIds)];
  for (let offset = 0; offset < uniqueDocumentIds.length; offset += 100) {
    const { data, error } = await client
      .from("document_overview")
      .select("id, reporting_period")
      .eq("company_id", companyId)
      .in("id", uniqueDocumentIds.slice(offset, offset + 100));
    if (error) throw error;
    documents.push(...data);
  }
  const periods = [...new Set(
    documents
      .map((document) => document.reporting_period)
      .filter((period): period is string => period !== null),
  )];
  if (periods.length === 0) return {};
  const lockedPeriods = new Set<string>();
  for (let offset = 0; offset < periods.length; offset += 100) {
    const { data, error } = await client
      .from("period_lock")
      .select("period")
      .eq("company_id", companyId)
      .in("period", periods.slice(offset, offset + 100));
    if (error) throw error;
    data.forEach((lock) => lockedPeriods.add(lock.period));
  }
  return Object.fromEntries(
    documents.flatMap((document) =>
      document.reporting_period && lockedPeriods.has(document.reporting_period)
        ? [[document.id, document.reporting_period]]
        : [],
    ),
  );
}

const DOCUMENT_COLUMNS = "id, company_id, source_file_id, first_page, last_page, source_sheet, first_row, last_row, has_document_image, status, created_at, receipt_date, claimed_reporting_period";

function toDocument(d: {
  id: string;
  company_id: string;
  source_file_id: string;
  first_page: number;
  last_page: number;
  source_sheet: string | null;
  first_row: number | null;
  last_row: number | null;
  has_document_image: boolean;
  status: DocumentStatus;
  created_at: string;
  receipt_date: string;
  claimed_reporting_period: string | null;
}): Document {
  const document: Document = {
    id: d.id,
    companyId: d.company_id,
    sourceFileId: d.source_file_id,
    firstPage: d.first_page,
    lastPage: d.last_page,
    status: d.status,
    createdAt: d.created_at,
    receiptDate: d.receipt_date,
    claimedReportingPeriod: d.claimed_reporting_period,
  };
  if (d.source_sheet !== null && d.first_row !== null && d.last_row !== null) {
    document.rowSet = { sheetName: d.source_sheet, firstRow: d.first_row, lastRow: d.last_row };
    document.hasDocumentImage = false;
  }
  return document;
}

/** The Documents a Source File of the Company was Split into, in page order. */
export async function listDocuments(client: AppClient, companyId: string, sourceFileId: string): Promise<Document[]> {
  if (!isUuid(companyId) || !isUuid(sourceFileId)) return [];
  const { data, error } = await client
    .from("document")
    .select(DOCUMENT_COLUMNS)
    .eq("company_id", companyId)
    .eq("source_file_id", sourceFileId)
    .is("superseded_at", null)
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
    .is("superseded_at", null)
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
  if (document.rowSet) return null;
  return {
    fileName: file.fileName,
    mediaType: SOURCE_FILE_MEDIA_TYPES[file.format],
    bytes: file.format === "pdf" ? await pdfPages(bytes, document) : bytes,
  };
}

/** The row-numbered source table shown for a row-based Document in review. */
export async function readDocumentRows(
  client: AppClient,
  companyId: string,
  documentId: string,
): Promise<(WorkbookRowSet & { fileName: string; text: string }) | null> {
  const document = await getDocument(client, companyId, documentId);
  if (!document?.rowSet) return null;
  const stored = await readSourceFile(client, companyId, document.sourceFileId);
  if (!stored) return null;
  return {
    fileName: stored.file.fileName,
    ...document.rowSet,
    text: workbookRowsToText(stored.bytes, document.rowSet),
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
    .select("id, document_id, version, provider, model, author_user_id, payload, findings, created_at")
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
    findings: v.findings as ValidationFinding[],
    createdAt: v.created_at,
  }));
}

export type CorrectDocumentError =
  | ExtractionPayloadError
  | "not_in_review"
  | "stale_version"
  | "period_locked"
  | "forbidden";

/**
 * Saves a User's corrections of a Document in review as its next Extraction
 * Version (ADR-0005), authored by them. Amounts and codes are read as people
 * type them ("1 210,5", "cz"). `basedOnVersion` is the version the
 * corrections start from; they are refused if a newer one has been recorded.
 * The provider's confidence describes its own reading, so it is not carried over.
 */
export async function correctDocument(
  client: AppClient,
  input: {
    companyId: string;
    documentId: string;
    basedOnVersion: number;
    payload: ExtractionPayload;
  },
  exchangeRates: ExchangeRateProvider = unavailableExchangeRates,
): Promise<Result<{ version: number }, CorrectDocumentError>> {
  let payload = normalizeExtractionPayload(input.payload);
  const invalid = validateExtractionPayload(payload);
  if (invalid) return { ok: false, error: invalid };
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  delete payload.confidence;
  const conversion = await applyCnbConversion(payload, exchangeRates);
  payload = conversion.payload;

  const { data: version, error } = await client.rpc("correct_document", {
    target_document_id: document,
    based_on_version: input.basedOnVersion,
    payload,
    findings: [
      ...validateDocument(payload, CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA),
      ...conversion.findings,
    ],
  });
  if (error) return refusal(error, ["not_in_review", "stale_version", "period_locked"]);
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
): Promise<Result<null, "not_in_review" | "stale_version" | "direction_required" | "invalid_credit_note_amount" | "period_locked" | "forbidden">> {
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("approve_document", {
    target_document_id: document,
    reviewed_version: input.version,
  });
  if (error) return refusal(error, [
    "not_in_review",
    "stale_version",
    "direction_required",
    "invalid_credit_note_amount",
    "period_locked",
  ]);
  return { ok: true, value: null };
}

/** Rejects a Document in review, excluding it from VAT Reports and the review queue. */
export async function rejectDocument(
  client: AppClient,
  input: { companyId: string; documentId: string },
): Promise<Result<null, "not_in_review" | "period_locked" | "forbidden">> {
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("reject_document", { target_document_id: document });
  if (error) return refusal(error, ["not_in_review", "period_locked"]);
  return { ok: true, value: null };
}

export type UpdateDocumentReportingError =
  | "invalid_receipt_date"
  | "invalid_tax_point_date"
  | "invalid_reporting_period"
  | "claimed_period_not_later"
  | "incoming_required"
  | "period_locked"
  | "forbidden";

function validDate(value: string): boolean {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

/** Changes an incoming Document's Receipt Date and optional later input-VAT claim. */
export async function updateDocumentReporting(
  client: AppClient,
  input: {
    companyId: string;
    documentId: string;
    receiptDate: string;
    claimedReportingPeriod: string | null;
  },
): Promise<Result<null, UpdateDocumentReportingError>> {
  if (!validDate(input.receiptDate)) {
    return { ok: false, error: "invalid_receipt_date" };
  }
  if (
    input.claimedReportingPeriod !== null &&
    !/^20\d{2}-(0[1-9]|1[0-2]|Q[1-4])$/.test(input.claimedReportingPeriod)
  ) {
    return { ok: false, error: "invalid_reporting_period" };
  }
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("update_document_reporting", {
    target_document_id: document,
    new_receipt_date: input.receiptDate,
    // PostgREST accepts SQL null here; generated RPC argument types do not
    // encode nullable function parameters.
    new_claimed_reporting_period: input.claimedReportingPeriod as string,
  });
  if (error) {
    return refusal(error, [
      "invalid_receipt_date",
      "invalid_tax_point_date",
      "invalid_reporting_period",
      "claimed_period_not_later",
      "incoming_required",
      "period_locked",
    ]);
  }
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
    .is("superseded_at", null)
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
): Promise<Result<null, "not_reprocessable" | "period_locked" | "forbidden">> {
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("reprocess_document", { target_document_id: document });
  if (error) return refusal(error, ["not_reprocessable", "period_locked"]);
  await jobs.send(extractJob(document));
  return { ok: true, value: null };
}

export type CorrectSplitError = "not_correctable" | "invalid_split_boundary" | "period_locked" | "forbidden";

async function enqueueCorrectedDocuments(jobs: JobQueue, documentIds: string[]) {
  for (const documentId of documentIds) await jobs.send(extractJob(documentId));
}

/** Merges two adjacent active Documents, keeping the left Document's history. */
export async function mergeDocuments(
  client: AppClient,
  jobs: JobQueue,
  input: { companyId: string; leftDocumentId: string; rightDocumentId: string },
): Promise<Result<null, CorrectSplitError>> {
  const [left, right] = await Promise.all([
    findDocumentId(client, input.companyId, input.leftDocumentId),
    findDocumentId(client, input.companyId, input.rightDocumentId),
  ]);
  if (!left || !right) return { ok: false, error: "forbidden" };
  const { data, error } = await client.rpc("merge_documents", {
    left_document_id: left,
    right_document_id: right,
  });
  if (error) return refusal(error, ["not_correctable", "invalid_split_boundary", "period_locked"]);
  await enqueueCorrectedDocuments(jobs, data);
  return { ok: true, value: null };
}

/** Splits an active Document after the named page; both results are re-extracted. */
export async function splitDocument(
  client: AppClient,
  jobs: JobQueue,
  input: { companyId: string; documentId: string; splitAfterPage: number },
): Promise<Result<null, CorrectSplitError>> {
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const { data, error } = await client.rpc("split_document", {
    target_document_id: document,
    split_after_page: input.splitAfterPage,
  });
  if (error) return refusal(error, ["not_correctable", "invalid_split_boundary", "period_locked"]);
  await enqueueCorrectedDocuments(jobs, data);
  return { ok: true, value: null };
}

/** Moves one shared boundary page from one active Document to its neighbour. */
export async function moveDocumentPage(
  client: AppClient,
  jobs: JobQueue,
  input: { companyId: string; sourceDocumentId: string; targetDocumentId: string; page: number },
): Promise<Result<null, CorrectSplitError>> {
  const [source, target] = await Promise.all([
    findDocumentId(client, input.companyId, input.sourceDocumentId),
    findDocumentId(client, input.companyId, input.targetDocumentId),
  ]);
  if (!source || !target) return { ok: false, error: "forbidden" };
  const { data, error } = await client.rpc("move_document_page", {
    source_document_id: source,
    target_document_id: target,
    page: input.page,
  });
  if (error) return refusal(error, ["not_correctable", "invalid_split_boundary", "period_locked"]);
  await enqueueCorrectedDocuments(jobs, data);
  return { ok: true, value: null };
}
