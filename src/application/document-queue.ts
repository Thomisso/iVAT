import {
  DOCUMENT_STATUSES,
  type DocumentFilters,
  type DocumentStatus,
} from "./documents";
import type { Direction } from "./extraction-payload";

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
};

const one = (value: string | string[] | undefined) =>
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
  const requestedView = one(search.view);
  const view = DOCUMENT_SAVED_VIEWS.includes(requestedView as DocumentSavedView)
    ? requestedView as DocumentSavedView
    : "review";
  const requestedStatus = one(search.status);
  const status = fixedStatus[view] ?? (
    DOCUMENT_STATUSES.includes(requestedStatus as DocumentStatus)
      ? requestedStatus as DocumentStatus
      : undefined
  );
  const requestedDirection = one(search.direction);
  const direction = fixedDirection[view] ?? (
    requestedDirection === "incoming" || requestedDirection === "outgoing"
      ? requestedDirection
      : undefined
  );
  const reportingPeriod = one(search.reportingPeriod)?.trim() || undefined;
  const counterparty = one(search.counterparty)?.trim() || undefined;
  const batchId = one(search.batchId)?.trim() || undefined;
  return {
    view,
    status,
    direction,
    reportingPeriod,
    counterparty,
    hasFindings: one(search.hasFindings) === "1",
    batchId,
  };
}

/** The Application filters represented by a queue, plus its optional upload batch. */
export function documentQueueFilters(
  queue: DocumentQueue,
  sourceFileIds?: string[],
): DocumentFilters {
  return {
    status: queue.status,
    direction: queue.direction,
    reportingPeriod: queue.reportingPeriod,
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
  return params;
}

export function documentQueueQuery(queue: DocumentQueue): string {
  return documentQueueSearchParams(queue).toString();
}

/** Re-parses a submitted query so redirects cannot preserve arbitrary parameters. */
export function normalizeDocumentQueueQuery(query: string): string {
  const params = new URLSearchParams(query);
  return documentQueueQuery(parseDocumentQueue(Object.fromEntries(params)));
}

