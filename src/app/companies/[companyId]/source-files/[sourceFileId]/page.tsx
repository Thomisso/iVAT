import { getSourcePhotoGroup } from "@/application/photo-groups";
import Link from "next/link";
import { companyPageContext, safeCompanyReturnTo, withCompanyReturnTo } from "@/application/return-context";
import { CompanyReturnLink } from "@/components/company-return-link";

import { ManualSourceForm, ManualWorkbookForm, SourceExclusionForm } from "./manual-source-form";
import { Notice } from "@/components/notice";
import { defineSourceDocumentsAction, startManualSourceReviewAction, restoreSourceFileAction } from "@/app/actions";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { mergeDocumentsAction, moveDocumentPageAction, reprocessDocumentAction, retrySplitAction } from "@/app/actions";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import { documentPeriodLocks, isBeingExtracted, listDocuments, listExtractionVersions } from "@/application/documents";
import { getSourceFile, readSourceWorkbook, sourceFilePeriodLock } from "@/application/source-files";
import { PageLayout } from "@/components/app-shell";
import { CommandButton } from "@/components/command-button";
import { RefreshWhile } from "@/components/refresh-while";
import { DataTable } from "@/components/data-table";
import { DocumentViewer } from "@/components/document-viewer";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { statusBadgeState } from "@/components/status-badge-state";
import { SplitDocumentForm } from "@/components/split-document-form";
import { formatDateTime } from "@/lib/format-date";
import { requireUserClient } from "@/lib/supabase/server";

export default async function SourceFilePage({
  params, searchParams,
}: PageProps<"/companies/[companyId]/source-files/[sourceFileId]">) {
  const { companyId, sourceFileId } = await params;
  const search = await searchParams;
  const returnTo = safeCompanyReturnTo(companyId, search.returnTo);
  const context = companyPageContext(companyId, `/companies/${companyId}/source-files/${sourceFileId}`, search);
  const client = await requireUserClient();
  const [company, file, role] = await Promise.all([
    getCompany(client, companyId),
    getSourceFile(client, companyId, sourceFileId),
    getMyCompanyRole(client, companyId),
  ]);
  if (!company || !file) notFound();
  const photoGroup = await getSourcePhotoGroup(client, companyId, sourceFileId);
  const documents = await Promise.all(
    (await listDocuments(client, companyId, file.id)).map(async (document) => ({
      ...document,
      current: (await listExtractionVersions(client, companyId, document.id)).at(-1),
    })),
  );
  const lockedSourcePeriod = await sourceFilePeriodLock(client, companyId, file.id);
  const lockedPeriods = await documentPeriodLocks(client, companyId, documents.map((document) => document.id));
  const t = await getTranslations();
  const format = await getFormatter();
  const contentUrl = file.normalizedDerivative
    ? `/companies/${companyId}/source-files/${file.id}/preview`
    : `/companies/${companyId}/source-files/${file.id}/content`;
  const workbook = file.format === "xlsx" || file.format === "xls";
  const workbookSource = workbook ? await readSourceWorkbook(client, companyId, file.id) : null;
  const waitingForAi = !company.aiProcessingEnabled && ["uploaded", "processing", "waiting_for_platform"].includes(file.status);
  const unresolvedSource = !photoGroup && documents.length === 0 && !["split", "rejected"].includes(file.status);
  // Nothing moves until the platform enables an assigned AI Configuration.
  const processing =
    company.aiProcessingEnabled &&
    (file.status === "uploaded" ||
      file.status === "processing" ||
      documents.some((d) => d.status === "uploaded" || d.status === "processing"));

  return (
    <>
      <PageLayout className="dashboard" measure="wide">
        <header>
          <p>
            <CompanyReturnLink companyId={companyId} returnTo={returnTo} fallback={`/companies/${companyId}`} />
          </p>
          <h1>{file.fileName}</h1>
          <p className="iv-muted">
            {file.format.toUpperCase()} · {workbook ? t("sourceFiles.workbook") : t("sourceFiles.pageCount", { count: file.pageCount })} ·{" "}
            {format.number(file.byteSize / 1000, {
              style: "unit",
              unit: "kilobyte",
              maximumFractionDigits: 1,
            })}{" "}
            · {formatDateTime(file.uploadedAt)}
          </p>
          <p className="iv-muted">
            {t("sourceFiles.hash")} <code className="hash">{file.sha256}</code>
          </p>
        </header>
        <section>
          <h2>{t("documents.title")}</h2>
          {photoGroup && <Notice>{photoGroup.basis ? <Link href={`/companies/${companyId}/documents/${photoGroup.id}`}>{t("sourceFiles.groupDocument")}</Link> : t(file.status === "failed" ? "sourceFiles.groupUnavailable" : "sourceFiles.groupPreparing")}</Notice>}
          <p>
            {t("sourceFiles.status")}:{" "}
            <StatusBadge status={statusBadgeState(file.status, "source-file")}>
              {t(`sourceFileStatus.${file.status}`)}
            </StatusBadge>
            {waitingForAi && <span className="iv-muted"> · {t("aiProcessing.waitingTitle")}</span>}
          </p>
          {waitingForAi && role === "administrator" && <p>
            <Link href={`/companies/${companyId}/settings`}>{t("aiProcessing.viewAllowance")}</Link>
          </p>}
          {unresolvedSource && !lockedSourcePeriod && (file.status === "failed" || file.status === "needs_review") && (
            <CommandButton
              variant="ai"
              icon="marker"
              action={retrySplitAction}
              fields={{ companyId, sourceFileId: file.id }}
            >
              {t("documents.retrySplit")}
            </CommandButton>
          )}
          {lockedSourcePeriod && <Notice tone="warning">{t("sourceFiles.lockedSource", { period: lockedSourcePeriod })}</Notice>}
          {file.exclusion && <Notice><p>{t("sourceFiles.excludedNote")}</p><p>{file.exclusion.reason} · {formatDateTime(file.exclusion.at)}</p></Notice>}
          {file.status === "rejected" && !lockedSourcePeriod && <CommandButton action={restoreSourceFileAction} fields={{ companyId, sourceFileId: file.id }}>{t("sourceFiles.reverseExclusion")}</CommandButton>}
          {file.manualDefinition && <Notice>{t("sourceFiles.manualDefined", { date: formatDateTime(file.manualDefinition.at) })}</Notice>}
          {unresolvedSource && !lockedSourcePeriod && <>
            {workbook ? (file.status === "needs_review" && workbookSource
              ? <ManualWorkbookForm companyId={companyId} sourceFileId={file.id} sheets={workbookSource.rowSets} />
              : <CommandButton action={startManualSourceReviewAction} fields={{ companyId, sourceFileId: file.id }}>{t("sourceFiles.manualStart")}</CommandButton>)
              : file.format !== "pdf" ? <CommandButton action={defineSourceDocumentsAction} fields={{ companyId, sourceFileId: file.id, firstPage: "1", lastPage: "1", openDocument: "1" }}>{t("sourceFiles.manualImage")}</CommandButton>
              : file.status === "needs_review" ? <ManualSourceForm companyId={companyId} sourceFileId={file.id} pageCount={file.pageCount} />
              : <CommandButton action={startManualSourceReviewAction} fields={{ companyId, sourceFileId: file.id }}>{t("sourceFiles.manualStart")}</CommandButton>}
            <SourceExclusionForm companyId={companyId} sourceFileId={file.id} />
          </>}
          {documents.length > 0 ? (
            <DataTable
              caption={t("documents.title")}
              rows={documents}
              rowId={(document) => `document-${document.id}`}
              columns={[
                {
                  key: "pages",
                  header: workbook ? t("documents.rows") : t("documents.pages"),
                  mono: true,
                  render: (document) => (
                    <Link href={withCompanyReturnTo(companyId, `/companies/${companyId}/documents/${document.id}`, `${context}#document-${document.id}`)}>
                      {document.rowSet
                        ? document.rowSet.firstRow === document.rowSet.lastRow
                          ? t("documents.row", { sheet: document.rowSet.sheetName, row: document.rowSet.firstRow })
                          : t("documents.rowRange", {
                              sheet: document.rowSet.sheetName,
                              first: document.rowSet.firstRow,
                              last: document.rowSet.lastRow,
                            })
                        : document.firstPage === document.lastPage
                          ? document.firstPage
                          : `${document.firstPage}–${document.lastPage}`}
                    </Link>
                  ),
                },
                {
                  key: "status",
                  header: t("documents.status"),
                  render: (document) => (
                    <StatusBadge status={statusBadgeState(document.status, "document")}>
                      {t(`documentStatus.${document.status}`)}
                    </StatusBadge>
                  ),
                },
                {
                  key: "extraction",
                  header: t("documents.extraction"),
                  mono: true,
                  render: (document) =>
                    document.current &&
                    t("documents.version", {
                      version: document.current.version,
                      documentNumber: document.current.payload.documentNumber ?? "—",
                      author:
                        document.current.author.kind === "ai"
                          ? t("review.aiAuthor")
                          : t("documents.userAuthor"),
                    }),
                },
                {
                  key: "splitCorrection",
                  header: t("documents.correctSplit"),
                  render: (document) => {
                    if (document.rowSet) return null;
                    const index = documents.findIndex((candidate) => candidate.id === document.id);
                    const previous = documents[index - 1];
                    const next = documents[index + 1];
                    const lockedPeriod = lockedPeriods[document.id];
                    const correctable = !photoGroup && !isBeingExtracted(document.status) && !lockedPeriod;
                    if (lockedPeriod) return <span className="iv-muted">{t("documents.lockedPeriod", { period: lockedPeriod })}</span>;
                    return (
                      <div className="split-correction-actions">
                        {correctable && document.firstPage < document.lastPage && (
                          <SplitDocumentForm
                            companyId={companyId}
                            documentId={document.id}
                            firstPage={document.firstPage}
                            lastPage={document.lastPage}
                          />
                        )}
                        {correctable && next && !isBeingExtracted(next.status) && !lockedPeriods[next.id] && (
                          <CommandButton
                            size="sm"
                            action={mergeDocumentsAction}
                            fields={{
                              companyId,
                              leftDocumentId: document.id,
                              rightDocumentId: next.id,
                            }}
                          >
                            {t("documents.mergeWithNext")}
                          </CommandButton>
                        )}
                        {correctable &&
                          next &&
                          !isBeingExtracted(next.status) &&
                          !lockedPeriods[next.id] &&
                          document.firstPage < document.lastPage && (
                            <CommandButton
                              size="sm"
                              action={moveDocumentPageAction}
                              fields={{
                                companyId,
                                sourceDocumentId: document.id,
                                targetDocumentId: next.id,
                                page: String(document.lastPage),
                              }}
                            >
                              {t("documents.moveLastToNext", {
                                page: document.lastPage,
                              })}
                            </CommandButton>
                          )}
                        {correctable &&
                          previous &&
                          !isBeingExtracted(previous.status) &&
                          !lockedPeriods[previous.id] &&
                          document.firstPage < document.lastPage && (
                            <CommandButton
                              size="sm"
                              action={moveDocumentPageAction}
                              fields={{
                                companyId,
                                sourceDocumentId: document.id,
                                targetDocumentId: previous.id,
                                page: String(document.firstPage),
                              }}
                            >
                              {t("documents.moveFirstToPrevious", {
                                page: document.firstPage,
                              })}
                            </CommandButton>
                          )}
                      </div>
                    );
                  },
                },
                {
                  key: "actions",
                  header: t("documents.review"),
                  render: (document) => {
                    const lockedPeriod = lockedPeriods[document.id];
                    if (lockedPeriod) return <span className="iv-muted">{t("documents.lockedPeriod", { period: lockedPeriod })}</span>;
                    if (["failed", "needs_review", "approved"].includes(document.status) && (document.current?.author.kind === "user" || document.status === "approved")) return <Link href={withCompanyReturnTo(companyId, `/companies/${companyId}/documents/${document.id}`, context)}>{t("review.aiReplacementTitle")}</Link>;
                    return (document.status === "failed" || document.status === "needs_review") && (
                      <CommandButton
                        variant="ai"
                        icon="marker"
                        size="sm"
                        action={reprocessDocumentAction}
                        fields={{ companyId, documentId: document.id }}
                      >
                        {document.status === "failed" ? t("documents.retry") : t("documents.reprocess")}
                      </CommandButton>
                    );
                  },
                },
              ]}
            />
          ) : (
            <EmptyState icon="file" title={t(file.status === "rejected" ? "uploadWorkspace.sourceExcludedNoDocuments" : "documents.none")} />
          )}
        </section>
        <DocumentViewer label={file.fileName}>
          {workbook ? (
            <div className="workbook-source">
              <p>{t("sourceFiles.workbookPreview")}</p>
              <a href={contentUrl}>{t("sourceFiles.downloadOriginal")}</a>
              <pre tabIndex={0}>{workbookSource?.text}</pre>
            </div>
          ) : file.format === "pdf" ? (
            <iframe src={contentUrl} title={file.fileName} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- the original is shown as stored, not optimized
            <img src={contentUrl} alt={file.fileName} />
          )}
        </DocumentViewer>
      </PageLayout>
      <RefreshWhile active={processing} />
    </>
  );
}
