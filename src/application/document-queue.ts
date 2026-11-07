import {
  DOCUMENT_STATUSES,
  listCompanyDocuments,
  type DocumentFilters,
  type DocumentOverview,
  type DocumentStatus,
} from "./documents";
import type { Direction } from "./extraction-payload";
import { isUuid, type AppClient } from "./client";
import { safeCompanyReturnTo, withCompanyReturnTo } from "./return-context";
import { NO_REPORTING_PERIOD, parseReportingPeriodFilter } from "./reporting-periods";
import { getUploadBatch, type UploadBatchWorkspace } from "./upload-batches";
import {
  getReportingPeriodReadiness,
  READINESS_DOCUMENT_FILTERS,
  readinessDocumentIds,
  type ReadinessDocumentFilter,
} from "./reporting-period-readiness";

export const DOCUMENT_SAVED_VIEWS = [
  "review",
  "failed",
  "incoming",
  "outgoing",
  "approved",
  "all",
] as const;

export type DocumentSavedView = (typeof DOCUMENT_SAVED_VIEWS)[number];
export type DocumentQueueSearch = Record<string, string | string[] | undefined>;

export type DocumentQueue = {
  view: DocumentSavedView;
  status?: DocumentStatus;
  direction?: Direction;
  reportingPeriod?: string;
  counterparty?: string;
  hasFindings: boolean;
  batchId?: string;
  readiness?: ReadinessDocumentFilter;
};

export type ResolvedDocumentQueue = {
  queue: DocumentQueue;
  batch: UploadBatchWorkspace | null;
  documents: DocumentOverview[];
};

const QUEUE_CONTEXT_KEYS = [
  "view",
  "status",
  "direction",
  "reportingPeriod",
  "counterparty",
  "hasFindings",
  "batchId",
  "readiness",
] as const;

const stringParam = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

const fixedStatus: Partial<Record<DocumentSavedView, DocumentStatus>> = {
  review: "needs_review",
  failed: "failed",
  approved: "approved",
};

const fixedDirection: Partial<Record<DocumentSavedView, Direction>> = {
  incoming: "incoming",
  outgoing: "outgoing",
};

/** Turns route search params into one canonical Documents queue context. */
export function parseDocumentQueue(search: DocumentQueueSearch): DocumentQueue {
  const requestedView = stringParam(search.view);
  const view = DOCUMENT_SAVED_VIEWS.includes(requestedView as DocumentSavedView)
    ? requestedView as DocumentSavedView
    : "review";
  const requestedStatus = stringParam(search.status);
  const reportingPeriod = parseReportingPeriodFilter(search.reportingPeriod);
  const requestedReadiness = stringParam(search.readiness);
  const readiness = reportingPeriod && reportingPeriod !== NO_REPORTING_PERIOD && READINESS_DOCUMENT_FILTERS.includes(requestedReadiness as ReadinessDocumentFilter)
    ? requestedReadiness as ReadinessDocumentFilter
    : undefined;
  const status = readiness === "rejected" ? "rejected" : fixedStatus[view] ?? (
    DOCUMENT_STATUSES.includes(requestedStatus as DocumentStatus)
      ? requestedStatus as DocumentStatus
      : undefined
  );
  const requestedDirection = stringParam(search.direction);
  const direction = fixedDirection[view] ?? (
    requestedDirection === "incoming" || requestedDirection === "outgoing"
      ? requestedDirection
      : undefined
  );
  const counterparty = stringParam(search.counterparty)?.trim() || undefined;
  const batchId = stringParam(search.batchId)?.trim() || undefined;
  return {
    view,
    status,
    direction,
    reportingPeriod,
    counterparty,
    hasFindings: stringParam(search.hasFindings) === "1",
    batchId,
    readiness,
  };
}

export function hasDocumentQueueContext(search: DocumentQueueSearch): boolean {
  return QUEUE_CONTEXT_KEYS.some((key) => typeof search[key] === "string");
}

/** The Application filters represented by a queue, plus its optional upload batch. */
export function documentQueueFilters(
  queue: DocumentQueue,
  sourceFileIds?: string[],
): DocumentFilters {
  return {
    status: queue.status,
    direction: queue.direction,
    reportingPeriod: queue.readiness ? undefined : queue.reportingPeriod,
    counterparty: queue.counterparty,
    hasFindings: queue.hasFindings || undefined,
    sourceFileIds,
  };
}

/** Stable URL serialization used by list links, navigation, and post-decision redirects. */
export function documentQueueSearchParams(queue: DocumentQueue): URLSearchParams {
  const params = new URLSearchParams({ view: queue.view });
  if (!fixedStatus[queue.view] && queue.status) params.set("status", queue.status);
  if (!fixedDirection[queue.view] && queue.direction) params.set("direction", queue.direction);
  if (queue.reportingPeriod) params.set("reportingPeriod", queue.reportingPeriod);
  if (queue.counterparty) params.set("counterparty", queue.counterparty);
  if (queue.hasFindings) params.set("hasFindings", "1");
  if (queue.batchId) params.set("batchId", queue.batchId);
  if (queue.readiness) params.set("readiness", queue.readiness);
  return params;
}

export function documentQueueQuery(queue: DocumentQueue): string {
  return documentQueueSearchParams(queue).toString();
}

/** Re-parses a submitted query so redirects cannot preserve arbitrary parameters. */
export function normalizeDocumentQueueQuery(query: string): string {
  const params = Object.fromEntries(new URLSearchParams(query));
  return hasDocumentQueueContext(params) ? documentQueueQuery(parseDocumentQueue(params)) : "";
}

/** Keeps queue continuation and an explicit work origin across authorized review decisions. */
export function documentDecisionHref(companyId: string, input: { documentId: string; nextDocumentId: string; queueQuery: string; returnTo?: unknown }): string {
  const query = normalizeDocumentQueueQuery(input.queueQuery);
  const origin = safeCompanyReturnTo(companyId, input.returnTo);
  if (query && isUuid(input.nextDocumentId)) return withCompanyReturnTo(companyId, `/companies/${companyId}/documents/${input.nextDocumentId}?${query}`, origin);
  return origin ?? `/companies/${companyId}/documents${query ? `?${query}` : ""}#document-${input.documentId}`;
}

/** Resolves a list route's filters, optional upload batch, and complete queue. */
export async function getDocumentQueue(
  client: AppClient,
  companyId: string,
  search: DocumentQueueSearch,
): Promise<ResolvedDocumentQueue> {
  const queue = parseDocumentQueue(search);
  const batch = queue.batchId ? await getUploadBatch(client, companyId, queue.batchId) : null;
  const sourceFileIds = queue.batchId ? (batch?.sourceFiles.map((source) => source.id) ?? []) : undefined;
  const documents = await listCompanyDocuments(client, companyId, documentQueueFilters(queue, sourceFileIds));
  if (!queue.readiness || !queue.reportingPeriod) return { queue, batch, documents };
  const readiness = await getReportingPeriodReadiness(client, {
    companyId,
    period: queue.reportingPeriod,
  });
  if (!readiness.ok) return { queue, batch, documents: [] };
  const included = new Set(readinessDocumentIds(readiness.value, queue.readiness));
  return { queue, batch, documents: documents.filter((document) => included.has(document.id)) };
}

export type DocumentQueuePosition = ResolvedDocumentQueue & {
  index: number;
  previousDocumentId?: string;
  nextDocumentId?: string;
  /** The next remaining item after a decision: forward first, then wrap backward. */
  continuationDocumentId?: string;
};

/** Resolves navigation around one Document; direct links intentionally have no implicit queue. */
export async function getDocumentQueuePosition(
  client: AppClient,
  companyId: string,
  documentId: string,
  search: DocumentQueueSearch,
): Promise<DocumentQueuePosition> {
  const queue = parseDocumentQueue(search);
  if (!hasDocumentQueueContext(search)) {
    return { queue, batch: null, documents: [], index: -1 };
  }
  const resolved = await getDocumentQueue(client, companyId, search);
  const index = resolved.documents.findIndex((document) => document.id === documentId);
  const previousDocumentId = index > 0 ? resolved.documents[index - 1].id : undefined;
  const nextDocumentId = index >= 0 ? resolved.documents[index + 1]?.id : undefined;
  return {
    ...resolved,
    index,
    previousDocumentId,
    nextDocumentId,
    continuationDocumentId: nextDocumentId ?? previousDocumentId,
  };
}
