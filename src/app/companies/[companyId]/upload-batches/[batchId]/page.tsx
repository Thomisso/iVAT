import Link from "next/link";
import { companyPageContext, safeCompanyReturnTo, withCompanyReturnTo } from "@/application/return-context";
import { CompanyReturnLink } from "@/components/company-return-link";

import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { reprocessDocumentAction, retrySplitAction } from "@/app/actions";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import { currentUserId } from "@/application/auth";
import { getUploadBatch, getUploadBatchDeletionPreview } from "@/application/upload-batches";
import { CommandButton } from "@/components/command-button";
import { RefreshWhile } from "@/components/refresh-while";
import { StatusBadge } from "@/components/status-badge";
import { statusBadgeState } from "@/components/status-badge-state";
import { PageLayout } from "@/components/app-shell";
import { requireUserClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/format-date";
import { BatchDeletionForm } from "./batch-deletion-form";
import { MarkBatchNotificationRead } from "./mark-batch-notification-read";

export default async function UploadBatchPage({
  params, searchParams,
}: PageProps<"/companies/[companyId]/upload-batches/[batchId]">) {
  const { companyId, batchId } = await params;
  const search = await searchParams;
  const returnTo = safeCompanyReturnTo(companyId, search.returnTo);
  const context = companyPageContext(companyId, `/companies/${companyId}/upload-batches/${batchId}`, search);
  const client = await requireUserClient();
  const [company, role, userId, batch, t] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    currentUserId(client),
    getUploadBatch(client, companyId, batchId),
    getTranslations("uploadWorkspace"),
  ]);
  if (!company || !batch) notFound();
  // The database decides who may delete; the Role only decides whether to offer it.
  const deletion = role === "administrator" || batch.createdBy === userId
    ? await getUploadBatchDeletionPreview(client, batch)
    : null;

  const phases = [
    { key: "transport", count: batch.actualFileCount, active: !batch.uploadFinishedAt },
    { key: "waiting", count: batch.counts.waiting, active: batch.counts.waiting > 0 },
    { key: "split", count: batch.counts.splitting, active: batch.counts.splitting > 0 },
    { key: "extraction", count: batch.counts.extracting, active: batch.counts.extracting > 0 },
    { key: "review", count: batch.counts.review, active: batch.counts.review > 0 },
  ] as const;
  const failedSources = batch.sourceFiles.filter((source) => source.status === "failed");
  const failedDocuments = batch.sourceFiles.flatMap((source) =>
    source.documents.filter((document) => document.status === "failed"),
  );
  const reviewHref = withCompanyReturnTo(companyId, `/companies/${companyId}/documents?view=review&batchId=${batch.id}`, context);

  return <PageLayout className="company-workspace upload-batch-workspace" measure="wide">
    <header className="company-page-header upload-batch-header">
      <div><CompanyReturnLink companyId={companyId} returnTo={returnTo} fallback={`/companies/${companyId}/upload`} /><h1>{t("batchTitle", { date: formatDateTime(batch.createdAt) })}</h1><p>{t("batchFiles", { count: batch.actualFileCount, planned: batch.plannedFileCount })}</p></div>
      <span className={`upload-outcome upload-outcome-${batch.outcome}`}>{t(`outcome.${batch.outcome}`)}</span>
    </header>

    {!company.aiProcessingEnabled && batch.counts.waiting > 0 && <section className="panel" role="status">
      <h2>{t("waitingForAi")}</h2><p>{t("waitingForAiHint")}</p>
      {role === "administrator" && <Link href={`/companies/${companyId}/settings`}>{t("configureAi")}</Link>}
    </section>}

    <ol className="upload-lifecycle" aria-label={t("lifecycle") }>
      {phases.map((phase, index) => <li className={phase.active ? "is-active" : ""} key={phase.key}>
        <span className="upload-phase-index" aria-hidden="true">{index + 1}</span>
        <span><strong>{t(`phase.${phase.key}`)}</strong><small>{t(`phaseHint.${phase.key}`)}</small></span>
        <b>{phase.count}</b>
      </li>)}
    </ol>

    {batch.counts.review > 0 && <section className="upload-review-handoff">
      <div><h2>{t("reviewReadyTitle")}</h2><p>{t("reviewReadyHint", { count: batch.counts.review })}</p></div>
      <Link className="iv-btn iv-btn-primary iv-btn-md" href={reviewHref}>{t("reviewAction", { count: batch.counts.review })}</Link>
    </section>}

    {batch.counts.failures > 0 && <section className="upload-failures" aria-labelledby="batch-failures-title">
      <div className="upload-section-heading"><div><h2 id="batch-failures-title">{t("failuresTitle")}</h2><p>{t("failuresHint")}</p></div><span>{batch.counts.failures}</span></div>
      {batch.counts.transportFailures > 0 && <p className="upload-failure-row">{t("transportFailures", { count: batch.counts.transportFailures })}</p>}
      {failedSources.map((source) => <div className="upload-failure-row" key={source.id}>
        <Link href={withCompanyReturnTo(companyId, `/companies/${companyId}/source-files/${source.id}`, `${context}#source-${source.id}`)}>{source.fileName}</Link>
        <span>{t("splitFailed")}</span>
        <CommandButton action={retrySplitAction} fields={{ companyId, sourceFileId: source.id }} size="sm" variant="ai">{t("retrySplit")}</CommandButton>
      </div>)}
      {failedDocuments.map((document) => <div className="upload-failure-row" key={document.id}>
        <Link href={withCompanyReturnTo(companyId, `/companies/${companyId}/documents/${document.id}`, `${context}#document-${document.id}`)}>{t("documentPages", { first: document.firstPage, last: document.lastPage })}</Link>
        <span>{t("extractionFailed")}</span>
        <CommandButton action={reprocessDocumentAction} fields={{ companyId, documentId: document.id }} size="sm" variant="ai">{t("retryExtraction")}</CommandButton>
      </div>)}
    </section>}

    <section className="upload-source-ledger" aria-labelledby="source-ledger-title">
      <div className="upload-section-heading"><div><h2 id="source-ledger-title">{t("sourceFilesTitle")}</h2><p>{t("sourceFilesHint")}</p></div><span>{batch.actualFileCount}</span></div>
      {batch.sourceFiles.map((source) => <article className="upload-source-row" key={source.id} id={`source-${source.id}`}>
        <header>
          <div><Link href={withCompanyReturnTo(companyId, `/companies/${companyId}/source-files/${source.id}`, `${context}#source-${source.id}`)}>{source.fileName}</Link><small>{formatDateTime(source.uploadedAt)}</small></div>
          <StatusBadge status={statusBadgeState(source.status, "source-file")}>{t(`sourceStatus.${source.status}`)}</StatusBadge>
        </header>
        {source.documents.length > 0 ? <ol className="upload-document-list">
          {source.documents.map((document) => <li key={document.id} id={`document-${document.id}`}>
            <Link href={withCompanyReturnTo(companyId, `/companies/${companyId}/documents/${document.id}`, `${context}#document-${document.id}`)}>{t("documentPages", { first: document.firstPage, last: document.lastPage })}</Link>
            <StatusBadge status={statusBadgeState(document.status, "document")}>{t(`documentStatus.${document.status}`)}</StatusBadge>
          </li>)}
        </ol> : <p className="iv-muted">{source.status === "failed" ? t("noDocumentsFailed") : t("noDocumentsYet")}</p>}
      </article>)}
    </section>
    {deletion && <BatchDeletionForm companyId={companyId} preview={deletion} returnTo={returnTo ?? undefined} />}
    <RefreshWhile active={batch.outcome === "processing"} />
    <MarkBatchNotificationRead batchId={batch.id} finished={batch.outcome !== "processing"} />
  </PageLayout>;
}
