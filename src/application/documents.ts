import { readPhotoGroupBasis } from "./photo-groups";
import { getCurrentDocumentReviewFindings, prepareDocumentCounterparty } from "./document-review-findings";
import { listCompanyReportingYears } from "./companies";
import { reportingPeriodForDate, reportingPeriodsOf, reportingPeriodStart } from "./reporting-periods";
import type { PostgrestError } from "@supabase/supabase-js";
import { isUuid, type AppClient, type Result } from "./client";
import {
  type Direction,
  type Party,
  type ExtractionPayload,
  type ManualDocumentPayloadError,
} from "./extraction-payload";
import { extractJob, type JobQueue } from "./processing";
import { isReportingPeriod, NO_REPORTING_PERIOD, pragueDate } from "./reporting-periods";
import {
  currentValidationFindings,
  type ValidationFinding,
} from "./document-validation";
import { pdfPages, readSourceFile, SOURCE_FILE_MEDIA_TYPES, prepareSourceFile, storeSourceFileObjects, type UploadSourceFileError } from "./source-files";
import { assertWorkbookRanges, workbookToText, workbookRowsToText, workbookRows, type WorkbookRows, type WorkbookRowSet } from "./workbooks";
import type { ExchangeRateProvider } from "./exchange-rates";
import type { VatPayerRegistry } from "./vat-registry";
import { prepareExtractionVersion, prepareManualExtractionPayload } from "./extraction-preparation";
import { prepareDocumentReporting, type DocumentReporting } from "./document-reporting";
import { currentBusinessDate } from "./business-date";
import { claimDeadline, confirmedZeroClaim, firstOrdinaryFilingDate, ordinaryDomesticClaim } from "./claim-eligibility";
import { randomUUID } from "node:crypto";
import type { SourceRange } from "./ai-provider";

const unavailableExchangeRates: ExchangeRateProvider = { rateFor: async () => null };
const unavailableVatPayerRegistry: VatPayerRegistry = { check: async () => ({ outcome: "unavailable" }) };

export type AttachDocumentSourceError = UploadSourceFileError | "not_attachable" | "source_already_attached" | "invalid_source_range" | "invalid_workbook_ranges" | "period_locked";

/** Adds evidence to the same Document without changing its human data or dispatching AI. */
export async function attachDocumentSource(client: AppClient, input: {
  companyId: string; documentId: string; fileName: string; bytes: Uint8Array; range?: SourceRange; sourceFileId?: string;
}): Promise<Result<{ sourceFileId: string }, AttachDocumentSourceError>> {
  if (!isUuid(input.companyId) || !isUuid(input.documentId) || (input.sourceFileId !== undefined && !isUuid(input.sourceFileId))) return { ok: false, error: "forbidden" };
  const sourceFileId = input.sourceFileId ?? randomUUID();
  const target = { target_company_id: input.companyId, target_document_id: input.documentId, target_source_file_id: sourceFileId };
  const allowed = await client.rpc("prepare_document_source_attachment", target);
  if (allowed.error) return refusal(allowed.error, ["not_attachable", "source_already_attached", "period_locked", "invalid_choice"]);
  const prepared = await prepareSourceFile(client, input);
  if (!prepared.ok) return prepared;
  const metadata = prepared.value;
  let range: SourceRange;
  if (metadata.format === "xlsx" || metadata.format === "xls") {
    try { assertWorkbookRanges(workbookToText(input.bytes).rowSets, [input.range]); }
    catch { return { ok: false, error: "invalid_workbook_ranges" }; }
    range = input.range!;
  } else {
    range = input.range ?? { firstPage: 1, lastPage: metadata.pageCount };
    if (!("firstPage" in range) || Object.keys(range).length !== 2 || !Number.isSafeInteger(range.firstPage) || !Number.isSafeInteger(range.lastPage)
      || range.firstPage < 1 || range.lastPage < range.firstPage || range.lastPage > metadata.pageCount) return { ok: false, error: "invalid_source_range" };
  }
  const stored = await storeSourceFileObjects(client, { companyId: input.companyId, sourceFileId, format: metadata.format, bytes: input.bytes });
  if (!stored.ok) return stored;
  const attached = await client.rpc("attach_document_source", { ...target, source_metadata: { ...metadata, ...stored.value }, source_range: range });
  if (attached.error) return refusal(attached.error, ["not_attachable", "source_already_attached", "period_locked", "invalid_choice", "invalid_source_range", "invalid_workbook_ranges"]);
  return { ok: true, value: { sourceFileId: attached.data } };
}

/** Creates the first User-authored Version without fabricating source evidence. */
export async function createManualDocument(
  client: AppClient,
  input: { companyId: string; payload: ExtractionPayload },
  exchangeRates: ExchangeRateProvider = unavailableExchangeRates,
  vatRegistry: VatPayerRegistry = unavailableVatPayerRegistry,
): Promise<{ ok: true; value: { id: string } } | { ok: false; error: ManualDocumentPayloadError | "forbidden" | "period_locked"; findings?: ValidationFinding[] }> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  const candidate = prepareManualExtractionPayload(input.payload);
  if (!candidate.ok) return candidate;
  const prepared = await prepareExtractionVersion(candidate.value, exchangeRates, vatRegistry);
  const { data, error } = await client.rpc("create_manual_document", {
    target_company_id: input.companyId,
    payload: prepared.payload,
    findings: await prepared.findings(),
  });
  if (error) return refusal(error, ["period_locked", "tax_point_date_required", "invalid_date"]);
  return { ok: true, value: { id: data } };
}

export const DOCUMENT_STATUSES = [
  "uploaded",
  "waiting_for_allowance",
  "waiting_for_platform",
  "processing",
  "needs_review",
  "approved",
  "rejected",
  "failed",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Whether Extraction of the Document is still to run or running. */
export const isBeingExtracted = (status: DocumentStatus) => status === "uploaded" || status === "processing";

export type Document = {
  id: string;
  companyId: string;
  sourceFileId: string | null;
  firstPage: number | null;
  lastPage: number | null;
  status: DocumentStatus;
  createdAt: string;
  /** The Prague calendar date its Source File was uploaded; informational only (ADR-0012). */
  importDate: string | null;
  /** An incoming Document's Deferred Claim: input VAT moved to a later Reporting Period. */
  claimedReportingPeriod: string | null;
  /** Current reasoned exclusion; earlier reasons remain in the Audit Trail. */
  exclusion?: { reason: string; at: string; userId: string | null };
  /** Present only for a Document identified by workbook rows instead of pages. */
  rowSet?: WorkbookRowSet;
  /** Present and false for row-based Documents, which have no page image. */
  hasDocumentImage?: false;
};

/** The source-scoped query can only return real file-backed ranges. */
export type SourceDocument = Document & {
  sourceFileId: string;
  firstPage: number;
  lastPage: number;
  importDate: string;
};

export type ExtractionVersionAuthor =
  { kind: "ai" } | { kind: "user"; userId: string };

export type ExtractionVersion = {
  id: string;
  documentId: string;
  version: number;
  author: ExtractionVersionAuthor;
  payload: ExtractionPayload;
  findings: ValidationFinding[];
  createdAt: string;
};

/** A Document as the Document list shows it: with the fields of its current Extraction Version. */
export type DocumentOverview = {
  id: string;
  sourceFileId: string | null;
  firstPage: number | null;
  lastPage: number | null;
  status: DocumentStatus;
  createdAt: string;
  /** The current Extraction Version; null until the first Extraction. */
  version: number | null;
  documentNumber: string | null;
  direction: Direction | null;
  taxPointDate: string | null;
  importDate: string | null;
  claimedReportingPeriod: string | null;
  reportingPeriod: string | null;
  /** The supplier of an incoming Document, the customer of an outgoing one; null while the Direction is unknown. */
  counterparty: Pick<Party, "name" | "vatId" | "ico"> | null;
  currency: string | null;
  grossAmount: string | null;
  findingCount: number;
  /** Actual live inclusion, rather than approval alone. */
  eligibleForVatReport: boolean;
  reporting: DocumentReporting;
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
  /** Specific Documents, for example those a readiness summary names. */
  documentIds?: string[];
  /** A Reporting Period ("2026-10", "2026-Q4"), or NO_REPORTING_PERIOD. */
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
  if (filters.documentIds?.length === 0) return [];
  const counterparty = filters.counterparty?.trim();
  const [reportingYears, evaluatedOn] = await Promise.all([listCompanyReportingYears(client, companyId), currentBusinessDate(client)]);
  const documents: DocumentOverview[] = [];
  for (let from = 0; ; from += 1000) {
    let query = client
      .from("document_overview")
      .select(
        "id, source_file_id, first_page, last_page, status, created_at, version, document_number, direction, tax_point_date, import_date, claimed_reporting_period, reporting_period, counterparty_name, counterparty_vat_id, counterparty_ico, currency, gross_amount, finding_count, proposed_vat_regime, extraction_version_id, reporting_payload, reporting_findings",
      )
      .eq("company_id", companyId);
    if (filters.sourceFileIds) query = query.in("source_file_id", filters.sourceFileIds);
    if (filters.documentIds) query = query.in("id", filters.documentIds);
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.direction) query = query.eq("direction", filters.direction);
    if (filters.reportingPeriod === NO_REPORTING_PERIOD) query = query.is("reporting_period", null);
    else if (filters.reportingPeriod) query = query.eq("reporting_period", filters.reportingPeriod);
    if (counterparty) query = query.ilike("counterparty_search", `%${likeLiteral(counterparty)}%`);

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("first_page")
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    documents.push(...data.map((d) => {
      const reporting = prepareDocumentReporting({
        id: d.id, status: d.status, extractionVersionId: d.extraction_version_id,
        payload: d.reporting_payload as unknown as ExtractionPayload | null,
        claimedReportingPeriod: d.claimed_reporting_period,
        importDate: d.import_date, sourceFileId: d.source_file_id,
      }, reportingYears, filters.reportingPeriod === NO_REPORTING_PERIOD ? undefined : filters.reportingPeriod,
      (d.reporting_findings ?? []) as ValidationFinding[], evaluatedOn);
      return {
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
        importDate: d.import_date,
        claimedReportingPeriod: d.claimed_reporting_period,
        reportingPeriod: d.reporting_period,
        counterparty: d.direction === null
          ? null
          : { name: d.counterparty_name, vatId: d.counterparty_vat_id, ico: d.counterparty_ico },
        currency: d.currency,
        grossAmount: d.gross_amount,
        findingCount: reporting.blockingFindings.length + reporting.advisoryFindings.length,
        eligibleForVatReport: reporting.included,
        reporting,
      };
    }).filter(document => !filters.hasFindings || document.findingCount > 0));
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

const DOCUMENT_COLUMNS = "id, company_id, source_file_id, first_page, last_page, source_sheet, first_row, last_row, has_document_image, status, created_at, claimed_reporting_period, exclusion_reason, excluded_at, excluded_by, source_file(uploaded_at)";

function toDocument(d: {
  id: string;
  company_id: string;
  source_file_id: string | null;
  first_page: number | null;
  last_page: number | null;
  source_sheet: string | null;
  first_row: number | null;
  last_row: number | null;
  has_document_image: boolean;
  status: DocumentStatus;
  created_at: string;
  claimed_reporting_period: string | null;
  exclusion_reason: string | null;
  excluded_at: string | null;
  excluded_by: string | null;
  source_file: { uploaded_at: string } | null;
}): Document {
  const document: Document = {
    id: d.id,
    companyId: d.company_id,
    sourceFileId: d.source_file_id,
    firstPage: d.first_page,
    lastPage: d.last_page,
    status: d.status,
    createdAt: d.created_at,
    importDate: d.source_file ? pragueDate(d.source_file.uploaded_at) : null,
    claimedReportingPeriod: d.claimed_reporting_period,
  };
  if (d.exclusion_reason && d.excluded_at) document.exclusion = { reason: d.exclusion_reason, at: d.excluded_at, userId: d.excluded_by };
  if (d.source_file_id === null) document.hasDocumentImage = false;
  if (d.source_sheet !== null && d.first_row !== null && d.last_row !== null) {
    document.rowSet = { sheetName: d.source_sheet, firstRow: d.first_row, lastRow: d.last_row };
    document.hasDocumentImage = false;
  }
  return document;
}

/** The Documents a Source File of the Company was Split into, in page order. */
export async function listDocuments(client: AppClient, companyId: string, sourceFileId: string): Promise<SourceDocument[]> {
  if (!isUuid(companyId) || !isUuid(sourceFileId)) return [];
  const { data, error } = await client
    .from("document")
    .select(DOCUMENT_COLUMNS)
    .eq("company_id", companyId)
    .eq("source_file_id", sourceFileId)
    .is("superseded_at", null)
    .order("first_page");
  if (error) throw error;
  return data.map((row) => {
    const document = toDocument(row);
    if (document.sourceFileId === null || document.firstPage === null || document.lastPage === null || document.importDate === null) {
      throw new Error("Source-scoped Document is missing its real source range");
    }
    return { ...document, sourceFileId: document.sourceFileId, firstPage: document.firstPage, lastPage: document.lastPage, importDate: document.importDate };
  });
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
  requestedVersion?: number,
): Promise<{ fileName: string; mediaType: string; bytes: Uint8Array } | null> {
  const document = await getDocument(client, companyId, documentId);
  if (!document?.sourceFileId || document.firstPage === null || document.lastPage === null) return null;
  const selected = requestedVersion === undefined ? undefined
    : (await listExtractionVersions(client, companyId, documentId)).find((version) => version.version === requestedVersion);
  if (requestedVersion !== undefined && !selected) return null;
  const groupBasis = await readPhotoGroupBasis(client, companyId, documentId);
  if (groupBasis) return { fileName: "photo-group.pdf", mediaType: "application/pdf", bytes: groupBasis.bytes };
  const stored = await readSourceFile(client, companyId, document.sourceFileId);
  if (!stored) return null;
  const { file, bytes } = stored;
  if (document.rowSet) return null;
  const evidence = selected?.payload.sourceEvidence;
  const bound = evidence?.documentId === document.id && evidence.sourceFileId === file.id
    && evidence.sourceSha256 === file.sha256 && evidence.basis.sha256 === file.sha256
    && evidence.extractionVersionId === selected?.id;
  const range = bound && "firstPage" in evidence.range ? evidence.range : { firstPage: document.firstPage, lastPage: document.lastPage };
  return {
    fileName: file.fileName,
    mediaType: SOURCE_FILE_MEDIA_TYPES[file.format],
    bytes: file.format === "pdf" ? await pdfPages(bytes, range) : bytes,
  };
}

/** The row-numbered source table shown for a row-based Document in review. */
export async function readDocumentRows(
  client: AppClient,
  companyId: string,
  documentId: string,
  requestedVersion?: number,
): Promise<(WorkbookRows & { fileName: string; text: string }) | null> {
  const document = await getDocument(client, companyId, documentId);
  if (!document?.rowSet || !document.sourceFileId) return null;
  const selected = requestedVersion === undefined ? undefined
    : (await listExtractionVersions(client, companyId, documentId)).find(version => version.version === requestedVersion);
  if (requestedVersion !== undefined && !selected) return null;
  const stored = await readSourceFile(client, companyId, document.sourceFileId);
  if (!stored) return null;
  const evidence = selected?.payload.sourceEvidence;
  const bound = evidence?.documentId === document.id && evidence.sourceFileId === stored.file.id
    && evidence.sourceSha256 === stored.file.sha256 && evidence.basis.kind === "original"
    && evidence.basis.format === stored.file.format && evidence.basis.sha256 === stored.file.sha256
    && evidence.extractionVersionId === selected?.id && "firstRow" in evidence.range;
  const range = bound && "firstRow" in evidence.range ? evidence.range : document.rowSet;
  return {
    fileName: stored.file.fileName,
    ...workbookRows(stored.bytes, range),
    text: workbookRowsToText(stored.bytes, range),
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
    .select("id, document_id, version, author_user_id, payload, findings, created_at")
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
      : { kind: "ai" },
    payload: v.payload as ExtractionPayload,
    findings: currentValidationFindings(v.payload as ExtractionPayload, v.findings as ValidationFinding[]),
    createdAt: v.created_at,
  }));
}

export type CorrectDocumentError =
  | ManualDocumentPayloadError
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
    requestId?: string;
    payload: ExtractionPayload;
  },
  exchangeRates: ExchangeRateProvider = unavailableExchangeRates,
  vatRegistry: VatPayerRegistry = unavailableVatPayerRegistry,
): Promise<{ ok: true; value: { version: number } } | { ok: false; error: CorrectDocumentError; findings?: ValidationFinding[]; conflict?: ReviewConflict }> {
  if (input.requestId !== undefined && !isUuid(input.requestId)) return { ok: false, error: "stale_version" };
  const candidate = prepareManualExtractionPayload(input.payload);
  if (!candidate.ok) return candidate;
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  if (input.requestId) {
    const replay = await client.rpc("document_approval_result", { target_document_id: document, request_id: input.requestId,
      submitted_payload: candidate.value, based_on_version: input.basedOnVersion, operation_kind: "draft" });
    if (replay.error) return documentReviewRefusal(client, input, refusal(replay.error, ["stale_version"]));
    if (replay.data !== null) return { ok: true, value: { version: replay.data } };
  }
  const directory = await prepareDocumentCounterparty(client, input.companyId, document, candidate.value);
  if (!directory.ok) return directory;
  const prepared = await prepareExtractionVersion(directory.value.payload, exchangeRates, vatRegistry);

  const fields = { target_document_id: document, based_on_version: input.basedOnVersion, payload: prepared.payload, findings: [...await prepared.findings(), ...directory.value.findings] };
  const { data: version, error } = input.requestId
    ? await client.rpc("save_document_review", { ...fields, request_id: input.requestId, submitted_payload: candidate.value })
    : await client.rpc("correct_document", fields);
  if (error) {
    const result = refusal(error, ["not_in_review", "stale_version", "period_locked", "tax_point_date_required", "invalid_date"]);
    return input.requestId ? documentReviewRefusal(client, input, result) : result;
  }
  return { ok: true, value: { version } };
}

/**
 * Approves a Document in review: a human confirms its current data, which then
 * counts towards VAT Reports (ADR-0003). `version` is the Extraction Version the
 * User reviewed; it is refused if a newer one has been recorded.
 */
const CLAIM_ELIGIBILITY_ERRORS = [
  "proportional_claim_year_mismatch", "proportional_deduction_invalid", "claimed_period_after_deadline", "claim_deadline_expired", "claim_document_type_required",
  "claim_eligibility_required", "invalid_earliest_claim_period", "claimed_period_before_earliest", "deferred_claim_not_supported",
] as const;
export type ClaimEligibilityError = (typeof CLAIM_ELIGIBILITY_ERRORS)[number];
export async function approveDocument(
  client: AppClient,
  input: { companyId: string; documentId: string; version: number },
): Promise<Result<null, ClaimEligibilityError | "counterparty_resolution_required" | "not_in_review" | "stale_version" | "direction_required" | "vat_regime_required" | "document_incomplete" | "document_validation_failed" | "counterparty_vat_id_required" | "currency_conversion_required" | "rate_breakdown_totals_mismatch" | "invalid_credit_note_amount" | "period_locked" | "forbidden">> {
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("approve_document", {
    target_document_id: document,
    reviewed_version: input.version,
  });
  if (error) return refusal(error, [
    "counterparty_resolution_required", ...CLAIM_ELIGIBILITY_ERRORS,
    "not_in_review",
    "stale_version",
    "direction_required",
    "vat_regime_required",
    "document_incomplete",
    "document_validation_failed",
    "counterparty_vat_id_required",
    "currency_conversion_required",
    "rate_breakdown_totals_mismatch",
    "invalid_credit_note_amount",
    "period_locked",
  ]);
  return { ok: true, value: null };
}

export type SaveAndApproveDocumentError = CorrectDocumentError | ClaimEligibilityError | "counterparty_resolution_required" | "direction_required" | "vat_regime_required" | "document_incomplete" | "document_validation_failed" | "counterparty_vat_id_required" | "currency_conversion_required" | "rate_breakdown_totals_mismatch" | "invalid_credit_note_amount" | "review_context_changed";
export type CounterpartyCreationConsent = { direction: Direction; party: Party };
export type ReviewConfirmation = { id: string; findings: ValidationFinding[] };
export type ReviewConflict = { version: number; status: DocumentStatus; payload: ExtractionPayload };
export type SaveAndApproveDocumentResult = { ok: true; value: { version: number } }
  | { ok: false; error: SaveAndApproveDocumentError; findings?: ValidationFinding[]; conflict?: ReviewConflict }
  | { ok: false; error: "review_warnings_changed"; confirmation: ReviewConfirmation };

async function documentReviewRefusal<E extends SaveAndApproveDocumentError>(client: AppClient, input: { companyId: string; documentId: string }, result: { ok: false; error: E }, findings?: ValidationFinding[]): Promise<{ ok: false; error: E; findings?: ValidationFinding[]; conflict?: ReviewConflict }> {
  if (!["stale_version", "not_in_review", "review_context_changed", "period_locked"].includes(result.error)) return { ...result, findings };
  const [document, version] = await Promise.all([
    getDocument(client, input.companyId, input.documentId),
    client.from("extraction_version").select("version, payload").eq("company_id", input.companyId).eq("document_id", input.documentId)
      .order("version", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (version.error) throw version.error;
  const current = version.data;
  return { ...result, ...(findings ? { findings } : {}), ...(document && current ? { conflict: { version: current.version, status: document.status, payload: current.payload as ExtractionPayload } } : {}) };
}

function warningIdentity(findings: ValidationFinding[]) {
  return JSON.stringify(findings.filter((finding) => finding.severity === "warning")
    .map((finding) => JSON.stringify(Object.entries(finding).sort(([left], [right]) => left.localeCompare(right)))).sort());
}

/**
 * Fresh preparation on every attempt; a database acknowledgement is valid only
 * for the exact prepared data, findings and unchanged accounting context.
 * External adapters supply observations as on creation/correction; PostgreSQL
 * independently enforces authorization, locks and financial invariants.
 */
export async function saveAndApproveDocument(
  client: AppClient,
  input: { companyId: string; documentId: string; basedOnVersion: number; requestId: string; payload: ExtractionPayload; counterpartyCreationConsent?: CounterpartyCreationConsent; acknowledgement?: string; displayedBankAccountCheckId?: string | null; displayedReviewContext?: string },
  exchangeRates: ExchangeRateProvider = unavailableExchangeRates,
  vatRegistry: VatPayerRegistry = unavailableVatPayerRegistry,
): Promise<SaveAndApproveDocumentResult> {
  if (!isUuid(input.requestId) || (input.acknowledgement !== undefined && !isUuid(input.acknowledgement))) return { ok: false, error: "stale_version" };
  const candidate = prepareManualExtractionPayload(input.payload);
  if (!candidate.ok) return candidate;
  const submittedPayload = input.counterpartyCreationConsent ? { ...candidate.value, counterpartyCreationConsent: input.counterpartyCreationConsent } : candidate.value;
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const replay = await client.rpc("document_approval_result", {
    target_document_id: document, request_id: input.requestId, submitted_payload: submittedPayload, based_on_version: input.basedOnVersion,
  });
  if (replay.error) return documentReviewRefusal(client, input, refusal(replay.error, ["stale_version"]));
  if (replay.data !== null) return { ok: true, value: { version: replay.data } };
  const context = await client.rpc("document_review_context", { target_document_id: document, based_on_version: input.basedOnVersion });
  if (context.error) return documentReviewRefusal(client, input, refusal(context.error, ["stale_version", "not_in_review"]));
  // Same query/projection as the actual current review; immutable Version
  // findings alone can differ after a dated Bank Account Check.
  const visible = await getCurrentDocumentReviewFindings(client, input);
  const directory = await prepareDocumentCounterparty(client, input.companyId, document, candidate.value);
  if (!directory.ok) return directory;
  const prepared = await prepareExtractionVersion(directory.value.payload, exchangeRates, vatRegistry);
  const findings = [...await prepared.findings(), ...directory.value.findings];
  const fields = {
    target_document_id: document, based_on_version: input.basedOnVersion, request_id: input.requestId,
    submitted_payload: submittedPayload, payload: prepared.payload, findings,
    expected_context: context.data,
  };
  let saved = await client.rpc("save_and_approve_document", { ...fields, acknowledgement: input.acknowledgement });
  const pending = saved.data as { confirmationId?: string; findings: ValidationFinding[]; unchanged?: boolean } | null;
  if (!saved.error && pending?.confirmationId && pending.unchanged && !input.acknowledgement
    && (input.displayedReviewContext === undefined || input.displayedReviewContext === visible.displayedReviewContext)
    && (input.displayedBankAccountCheckId === undefined || input.displayedBankAccountCheckId === (visible.current?.id ?? null))
    && warningIdentity(pending.findings) === warningIdentity(visible.findings)) {
    // These unchanged warnings are already visible. Confirm the opaque receipt,
    // with the original context checked again against any intervening change.
    saved = await client.rpc("save_and_approve_document", { ...fields, acknowledgement: pending.confirmationId });
  }
  const { data, error } = saved;
  if (error) return documentReviewRefusal(client, input, refusal(error, ["counterparty_resolution_required", ...CLAIM_ELIGIBILITY_ERRORS, "not_in_review", "stale_version", "period_locked", "tax_point_date_required", "invalid_date", "direction_required", "vat_regime_required", "document_incomplete", "document_validation_failed", "counterparty_vat_id_required", "currency_conversion_required", "rate_breakdown_totals_mismatch", "invalid_credit_note_amount", "review_context_changed"]), findings);
  const result = data as { version: number } | { confirmationId: string; findings: ValidationFinding[] };
  return "confirmationId" in result
    ? { ok: false, error: "review_warnings_changed", confirmation: { id: result.confirmationId, findings: result.findings } }
    : { ok: true, value: { version: result.version } };
}

/** Takes ownership of unfinished Extraction without requesting or consuming AI work. */
export async function startManualDocumentReview(
  client: AppClient,
  input: { companyId: string; documentId: string },
): Promise<Result<null, "not_recoverable" | "period_locked" | "forbidden">> {
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("start_manual_document_review", { target_document_id: document });
  if (error) return refusal(error, ["not_recoverable", "period_locked"]);
  return { ok: true, value: null };
}

/** Reverses exclusion into manual review; it never starts paid processing. */
export async function restoreDocument(
  client: AppClient,
  input: { companyId: string; documentId: string },
): Promise<Result<null, "not_rejected" | "period_locked" | "forbidden">> {
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("restore_document", { target_document_id: document });
  if (error) return refusal(error, ["not_rejected", "period_locked"]);
  return { ok: true, value: null };
}

/** Excludes unfinished work with a reason, preserving its original and immutable Versions. */
export async function rejectDocument(
  client: AppClient,
  input: { companyId: string; documentId: string; reason: string },
): Promise<Result<null, "not_in_review" | "exclusion_reason_required" | "period_locked" | "forbidden">> {
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("reject_document", { target_document_id: document, rejection_reason: input.reason });
  if (error) return refusal(error, ["not_in_review", "exclusion_reason_required", "period_locked"]);
  return { ok: true, value: null };
}

/**
 * Returns an Approved Document to review: its approval is withdrawn, so it
 * leaves VAT Reports until it is corrected and approved again. Refused while
 * its Reporting Period has a Period Lock (ADR-0007).
 */
export async function returnDocumentToReview(
  client: AppClient,
  input: { companyId: string; documentId: string },
): Promise<Result<null, "not_approved" | "period_locked" | "forbidden">> {
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("return_document_to_review", { target_document_id: document });
  if (error) return refusal(error, ["not_approved", "period_locked"]);
  return { ok: true, value: null };
}

export type UpdateDocumentReportingError = ClaimEligibilityError | "not_in_review"
  | "invalid_tax_point_date"
  | "invalid_reporting_period"
  | "claimed_period_not_later"
  | "incoming_required"
  | "period_locked"
  | "forbidden";

/** Sets or clears an incoming Document's Deferred Claim. */
export async function updateDocumentReporting(
  client: AppClient,
  input: {
    companyId: string;
    documentId: string;
    claimedReportingPeriod: string | null;
  },
): Promise<Result<null, UpdateDocumentReportingError>> {
  if (
    input.claimedReportingPeriod !== null &&
    !isReportingPeriod(input.claimedReportingPeriod)
  ) {
    return { ok: false, error: "invalid_reporting_period" };
  }
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("update_document_reporting", {
    target_document_id: document,
    // PostgREST accepts SQL null here; generated RPC argument types do not
    // encode nullable function parameters.
    new_claimed_reporting_period: input.claimedReportingPeriod as string,
  });
  if (error) {
    return refusal(error, [
      "invalid_tax_point_date",
      "invalid_reporting_period",
      "claimed_period_not_later",
      "incoming_required",
      ...CLAIM_ELIGIBILITY_ERRORS, "not_in_review",
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

export type ReprocessDocumentError = "not_reprocessable" | "period_locked" | "forbidden" | "confirmation_required" | "ai_configuration_unavailable" | "allowance_exhausted" | "processing_dispatch_failed";

/** Requests another immutable AI Version; replacing human work requires explicit consent. */
export async function reprocessDocument(
  client: AppClient,
  jobs: JobQueue,
  input: { companyId: string; documentId: string; confirmed?: boolean },
): Promise<Result<null, ReprocessDocumentError>> {
  const document = await findDocumentId(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const { data: requestId, error } = await client.rpc("reprocess_document", { target_document_id: document, replacement_confirmed: input.confirmed === true });
  if (error) return refusal(error, ["not_reprocessable", "period_locked", "confirmation_required", "ai_configuration_unavailable", "allowance_exhausted"]);
  try { await jobs.send(extractJob(document)); }
  catch {
    // The receipt belongs to this request only. A lost acknowledgement after
    // completion, or newer human work, must never be rolled back.
    const cancelled = await client.rpc("cancel_document_reprocess_dispatch", { target_document_id: document, target_extraction_request_id: requestId });
    if (cancelled.error) return refusal(cancelled.error, []);
    if (cancelled.data !== "completed") return { ok: false, error: "processing_dispatch_failed" };
  }
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

/** Unlocked generated periods that can support an ordinary claim before its filing deadline. */
export async function listDeferredClaimPeriods(client: AppClient, companyId: string, documentId: string): Promise<string[]> {
  const document = await getDocument(client, companyId, documentId);
  if (!document) return [];
  const versions = await listExtractionVersions(client, companyId, documentId);
  const payload = versions.at(-1)?.payload;
  const date = payload?.taxPointDate;
  if (!payload || !ordinaryDomesticClaim(payload) || document.status !== "needs_review" || !date || !/^20\d{2}-\d{2}-\d{2}$/.test(date)) return [];
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) return [];
  const years = await listCompanyReportingYears(client, companyId);
  const source = reportingPeriodForDate(date, years);
  if (!source) return [];
  const deadline = claimDeadline(payload, years, await currentBusinessDate(client));
  const zero = confirmedZeroClaim(payload);
  if (!zero && (!deadline || deadline.evaluatedOn > deadline.lastFilingDate)) return [];
  const candidates = reportingPeriodsOf(years).filter((period) => {
    const start = reportingPeriodStart(period)!;
    const earliest = payload.claimEligibility?.confirmed ? reportingPeriodStart(payload.claimEligibility.period) : null;
    return start > reportingPeriodStart(source)! && (zero || firstOrdinaryFilingDate(period)! <= deadline!.lastFilingDate) && (!earliest || start >= earliest)
      && (!payload.proportionalDeduction || period.slice(0, 4) === (payload.claimEligibility?.period ?? source).slice(0, 4));
  });
  if (!candidates.length) return [];
  const { data, error } = await client.from("period_lock").select("period").eq("company_id", companyId).in("period", candidates);
  if (error) throw error;
  const locked = new Set(data.map((lock) => lock.period));
  return candidates.filter((period) => !locked.has(period));
}
