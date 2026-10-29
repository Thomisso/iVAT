import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { mergeDocumentsAction, moveDocumentPageAction, reprocessDocumentAction, retrySplitAction } from "@/app/actions";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import { documentPeriodLocks, isBeingExtracted, listDocuments, listExtractionVersions } from "@/application/documents";
import { getSourceFile } from "@/application/source-files";
import { PageLayout } from "@/components/app-shell";
import { CommandButton } from "@/components/command-button";
import { RefreshWhile } from "@/components/refresh-while";
import { DataTable } from "@/components/data-table";
import { DocumentViewer } from "@/components/document-viewer";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { statusBadgeState } from "@/components/status-badge-state";
import { SplitDocumentForm } from "@/components/split-document-form";
import { formatDocumentDate } from "@/lib/format-date";
import { requireUserClient } from "@/lib/supabase/server";

export default async function SourceFilePage({
  params,
}: PageProps<"/companies/[companyId]/source-files/[sourceFileId]">) {
  const { companyId, sourceFileId } = await params;
  const client = await requireUserClient();
  const [company, file, role] = await Promise.all([
    getCompany(client, companyId),
    getSourceFile(client, companyId, sourceFileId),
    getMyCompanyRole(client, companyId),
  ]);
  if (!company || !file) notFound();
  const documents = await Promise.all(
    (await listDocuments(client, companyId, file.id)).map(async (document) => ({
      ...document,
      current: (await listExtractionVersions(client, companyId, document.id)).at(-1),
    })),
  );
  const lockedPeriods = await documentPeriodLocks(client, companyId, documents.map((document) => document.id));
  const t = await getTranslations();
  const format = await getFormatter();
  const contentUrl = file.normalizedDerivative
    ? `/companies/${companyId}/source-files/${file.id}/preview`
    : `/companies/${companyId}/source-files/${file.id}/content`;
  const workbook = file.format === "xlsx" || file.format === "xls";
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
            <Link href={`/companies/${companyId}`}>{t("sourceFiles.backToCompany")}</Link>
          </p>
          <h1>{file.fileName}</h1>
          <p className="iv-muted">
            {file.format.toUpperCase()} · {workbook ? t("sourceFiles.workbook") : t("sourceFiles.pageCount", { count: file.pageCount })} ·{" "}
            {format.number(file.byteSize / 1000, {
              style: "unit",
              unit: "kilobyte",
              maximumFractionDigits: 1,
            })}{" "}
            · {formatDocumentDate(file.uploadedAt, true)}
          </p>
          <p className="iv-muted">
            {t("sourceFiles.hash")} <code className="hash">{file.sha256}</code>
          </p>
        </header>
        <section>
          <h2>{t("documents.title")}</h2>
          <p>
            {t("sourceFiles.status")}:{" "}
            <StatusBadge status={statusBadgeState(file.status, "source-file")}>
              {t(`sourceFileStatus.${file.status}`)}
            </StatusBadge>
            {!company.aiProcessingEnabled && <span className="iv-muted"> · {t("aiProcessing.waitingTitle")}</span>}
          </p>
          {!company.aiProcessingEnabled && role === "administrator" && <p>
            <Link href={`/companies/${companyId}/settings`}>{t("aiProcessing.viewAllowance")}</Link>
          </p>}
          {file.status === "failed" && (
            <CommandButton
              variant="ai"
              icon="marker"
              action={retrySplitAction}
              fields={{ companyId, sourceFileId: file.id }}
            >
              {t("documents.retrySplit")}
            </CommandButton>
          )}
          {documents.length > 0 ? (
            <DataTable
              caption={t("documents.title")}
              rows={documents}
              columns={[
                {
                  key: "pages",
                  header: workbook ? t("documents.rows") : t("documents.pages"),
                  mono: true,
                  render: (document) => (
                    <Link href={`/companies/${companyId}/documents/${document.id}`}>
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
                    const correctable = !isBeingExtracted(document.status) && !lockedPeriod;
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
            <EmptyState icon="file" title={t("documents.none")} />
          )}
        </section>
        <DocumentViewer label={file.fileName}>
          {workbook ? (
            <div className="workbook-source">
              <p>{t("sourceFiles.workbookPreview")}</p>
              <a href={contentUrl}>{t("sourceFiles.downloadOriginal")}</a>
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
