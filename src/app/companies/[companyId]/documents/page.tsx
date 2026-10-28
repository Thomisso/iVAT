import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import {
  DOCUMENT_SAVED_VIEWS,
  documentQueueQuery,
  getDocumentQueue,
  parseDocumentQueue,
  type DocumentSavedView,
} from "@/application/document-queue";
import { DOCUMENT_STATUSES } from "@/application/documents";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { statusBadgeState } from "@/components/status-badge-state";
import { formatDocumentDate } from "@/lib/format-date";
import { requireUserClient } from "@/lib/supabase/server";

export default async function DocumentsPage({ params, searchParams }: PageProps<"/companies/[companyId]/documents">) {
  const { companyId } = await params;
  const search = await searchParams;
  const client = await requireUserClient();
  const { queue, batch, documents } = await getDocumentQueue(client, companyId, search);
  const queueQuery = documentQueueQuery(queue);
  const t = await getTranslations();
  const format = await getFormatter();
  const tabQueue = (view: DocumentSavedView) => documentQueueQuery(parseDocumentQueue({
    view,
    reportingPeriod: queue.reportingPeriod,
    counterparty: queue.counterparty,
    hasFindings: queue.hasFindings ? "1" : undefined,
    batchId: queue.batchId,
  }));
  const clearQueue = documentQueueQuery(parseDocumentQueue({ view: queue.view, batchId: queue.batchId }));

  return <main className="company-workspace documents-workspace">
    <header className="company-page-header">
      <h1>{t("shell.documentsTitle")}</h1>
      <p>{batch ? t("uploadWorkspace.filteredQueue", { count: documents.length }) : t("shell.documentsDescription")}</p>
      {batch && <Link href={`/companies/${companyId}/upload-batches/${batch.id}`}>{t("uploadWorkspace.backToBatch")}</Link>}
    </header>
    <nav className="document-saved-views" aria-label={t("documents.savedViewsLabel")}>
      {DOCUMENT_SAVED_VIEWS.map((view) => <Link key={view} href={`/companies/${companyId}/documents?${tabQueue(view)}`} aria-current={queue.view === view ? "page" : undefined}>{t(`documents.savedViews.${view}`)}</Link>)}
    </nav>
    <form action={`/companies/${companyId}/documents`} className="document-queue-filters">
      <input type="hidden" name="view" value={queue.view} />
      {queue.batchId && <input type="hidden" name="batchId" value={queue.batchId} />}
      {!(["review", "failed", "approved"] as string[]).includes(queue.view) && <label><span>{t("documents.status")}</span><select className="iv-input" name="status" defaultValue={queue.status ?? ""}><option value="">{t("documents.allStatuses")}</option>{DOCUMENT_STATUSES.map((status) => <option key={status} value={status}>{t(`documentStatus.${status}`)}</option>)}</select></label>}
      {!(["incoming", "outgoing"] as string[]).includes(queue.view) && <label><span>{t("documents.direction")}</span><select className="iv-input" name="direction" defaultValue={queue.direction ?? ""}><option value="">{t("documents.allDirections")}</option><option value="incoming">{t("review.direction.incoming")}</option><option value="outgoing">{t("review.direction.outgoing")}</option></select></label>}
      <label><span>{t("documents.reportingPeriod")}</span><input className="iv-input" name="reportingPeriod" defaultValue={queue.reportingPeriod} placeholder="2026-10" /></label>
      <label><span>{t("documents.counterparty")}</span><input className="iv-input" name="counterparty" defaultValue={queue.counterparty} placeholder={t("documents.counterpartyHint")} /></label>
      <label className="document-findings-filter"><input type="checkbox" name="hasFindings" value="1" defaultChecked={queue.hasFindings} /><span>{t("documents.findingsOnly")}</span></label>
      <button className="iv-btn iv-btn-primary" type="submit">{t("documents.filter")}</button>
      <Link href={`/companies/${companyId}/documents?${clearQueue}`}>{t("documents.clearFilters")}</Link>
    </form>
    <p className="document-queue-count">{t("documents.queueCount", { count: documents.length })}</p>
    {documents.length > 0 ? <DataTable
      caption={t("shell.documentsTitle")}
      rows={documents}
      rowId={(document) => `document-${document.id}`}
      columns={[
        { key: "counterparty", header: t("documents.counterparty"), render: (document) => <Link href={`/companies/${companyId}/documents/${document.id}?${queueQuery}`}>{document.counterparty?.name ?? document.counterparty?.vatId ?? t("documents.unknownCounterparty")}</Link> },
        { key: "document", header: t("documents.documentNumber"), mono: true, render: (document) => document.documentNumber ?? t("uploadWorkspace.documentPages", { first: document.firstPage, last: document.lastPage }) },
        { key: "direction", header: t("documents.direction"), render: (document) => document.direction ? t(`review.direction.${document.direction}`) : "—" },
        { key: "date", header: t("documents.taxPointDate"), render: (document) => document.taxPointDate ? formatDocumentDate(document.taxPointDate) : "—" },
        { key: "amount", header: t("documents.grossAmount"), align: "right", mono: true, render: (document) => document.grossAmount && document.currency ? format.number(Number(document.grossAmount), { style: "currency", currency: document.currency }) : "—" },
        { key: "status", header: t("documents.status"), render: (document) => <StatusBadge status={statusBadgeState(document.status, "document")}>{t(`documentStatus.${document.status}`)}</StatusBadge> },
      ]}
    /> : <section className="company-workspace-empty"><span aria-hidden="true" /><p>{t("documents.noMatch")}</p></section>}
  </main>;
}
