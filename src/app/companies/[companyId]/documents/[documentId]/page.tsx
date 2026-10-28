import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { approveDocumentAction, rejectDocumentAction } from "@/app/actions";
import { getCompany } from "@/application/companies";
import { currentUserId } from "@/application/auth";
import {
  getDocument,
  isBeingExtracted,
  listDuplicateWarnings,
  listExtractionVersions,
  readDocumentRows,
} from "@/application/documents";
import { getSourceFile } from "@/application/source-files";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandButton } from "@/components/command-button";
import { RefreshWhile } from "@/components/refresh-while";
import { requireUserClient } from "@/lib/supabase/server";
import { DocumentViewer } from "@/components/document-viewer";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { StatusBadge } from "@/components/status-badge";
import { statusBadgeState } from "@/components/status-badge-state";
import { formatDocumentDate } from "@/lib/format-date";
import { CorrectionForm } from "./correction-form";
import { ReportingAssignmentForm } from "./reporting-assignment-form";

// The review workspace: the Document's original pages next to its extracted
// data. `?version=N` shows an earlier Extraction Version read-only.
export default async function DocumentReviewPage({
  params,
  searchParams,
}: PageProps<"/companies/[companyId]/documents/[documentId]">) {
  const { companyId, documentId } = await params;
  const { version: requestedVersion } = await searchParams;
  const client = await requireUserClient();
  const [company, document, versions, userId, duplicateWarnings] = await Promise.all([
    getCompany(client, companyId),
    getDocument(client, companyId, documentId),
    listExtractionVersions(client, companyId, documentId),
    currentUserId(client),
    listDuplicateWarnings(client, companyId, documentId),
  ]);
  if (!company || !document) notFound();
  const file = await getSourceFile(client, companyId, document.sourceFileId);
  if (!file) notFound();
  const t = await getTranslations();
  const sourceRows = document.rowSet
    ? await readDocumentRows(client, companyId, document.id)
    : null;

  const current = versions.at(-1);
  const shown =
    versions.find((v) => String(v.version) === requestedVersion) ?? current;
  const reviewing = document.status === "needs_review" && current !== undefined;
  const contentUrl = `/companies/${companyId}/documents/${document.id}/content`;
  const sourceLocation = document.rowSet
    ? document.rowSet.firstRow === document.rowSet.lastRow
      ? t("review.row", { sheet: document.rowSet.sheetName, row: document.rowSet.firstRow })
      : t("review.rowRange", {
          sheet: document.rowSet.sheetName,
          first: document.rowSet.firstRow,
          last: document.rowSet.lastRow,
        })
    : document.firstPage === document.lastPage
      ? t("review.page", { page: document.firstPage })
      : t("review.pageRange", { first: document.firstPage, last: document.lastPage });

  return (
    <>
      <AppSidebar currentCompanyId={companyId} />
      <main className="review">
        <header className="review-header">
          <p>
            <Link href={`/companies/${companyId}`}>
              {t("review.backToCompany")}
            </Link>
          </p>
          <h1>
            {t("review.title")}
            {current?.payload.documentNumber && (
              <span className="iv-mono"> {current.payload.documentNumber}</span>
            )}
          </h1>
          <p className="iv-muted">
            <Link href={`/companies/${companyId}/source-files/${file.id}`}>
              {t("review.sourceFile", { fileName: file.fileName, pages: sourceLocation })}
            </Link>
          </p>
          <p>
            {t("review.status")}:{" "}
            <StatusBadge status={statusBadgeState(document.status, "document")}>
              {t(`documentStatus.${document.status}`)}
            </StatusBadge>
          </p>
          {document.status === "approved" && (
            <Notice>{t("review.approvedNote")}</Notice>
          )}
          {document.status === "rejected" && (
            <Notice>{t("review.rejectedNote")}</Notice>
          )}
          {!current && <Notice>{t("review.notReviewableNote")}</Notice>}
          {duplicateWarnings.map((warning) => (
            <Notice key={`${warning.kind}-${warning.matchedDocumentId}`} tone="warning">
              {t(`duplicateWarning.${warning.kind}`)}{" "}
              <Link href={`/companies/${companyId}/documents/${warning.matchedDocumentId}`}>
                {t("duplicateWarning.openMatch")}
              </Link>
            </Notice>
          ))}
        </header>
        <section className="review-original">
          <DocumentViewer label={file.fileName}>
            {document.rowSet ? (
              <div className="workbook-source">
                <Notice>{t("review.noDocumentImage")}</Notice>
                <pre>{sourceRows?.text}</pre>
              </div>
            ) : file.format === "pdf" ? (
              <iframe src={contentUrl} title={file.fileName} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- the original is shown as stored, not optimized
              <img src={contentUrl} alt={file.fileName} />
            )}
          </DocumentViewer>
        </section>
        <section className="review-data">
          {shown && current && shown !== current && (
            <Notice>
              {t("review.viewingOld", {
                version: shown.version,
                current: current.version,
              })}{" "}
              <Link href={`/companies/${companyId}/documents/${document.id}`}>
                {t("review.showCurrent")}
              </Link>
            </Notice>
          )}
          {shown?.findings
            .filter((finding) => finding.severity === "warning")
            .map((finding) => (
              <Notice
                key={`${finding.field}-${finding.code}`}
                tone="warning"
              >
                {t(`review.findings.${finding.code}`)}
              </Notice>
            ))}
          {shown ? (
            <CorrectionForm
              key={shown.id}
              companyId={companyId}
              documentId={document.id}
              version={shown.version}
              payload={shown.payload}
              findings={shown.findings}
              editable={reviewing && shown === current}
              aiProposed={
                shown.author.kind === "ai" && document.status !== "approved"
              }
            />
          ) : (
            <EmptyState icon="file" title={t("review.noExtraction")} />
          )}
          {current?.payload.direction === "incoming" && (
            <ReportingAssignmentForm
              companyId={companyId}
              documentId={document.id}
              receiptDate={document.receiptDate}
              claimedReportingPeriod={document.claimedReportingPeriod}
            />
          )}
          {reviewing && (
            <div className="review-decision">
              <CommandButton
                variant="primary"
                icon="check"
                action={approveDocumentAction}
                fields={{
                  companyId,
                  documentId: document.id,
                  version: String(current.version),
                }}
              >
                {t("review.approve", { version: current.version })}
              </CommandButton>
              <CommandButton
                variant="danger"
                action={rejectDocumentAction}
                fields={{ companyId, documentId: document.id }}
              >
                {t("review.reject")}
              </CommandButton>
            </div>
          )}
          {versions.length > 0 && (
            <>
              <h2>{t("review.history")}</h2>
              <ol className="version-history" reversed>
                {versions.toReversed().map((v) => (
                  <li
                    key={v.id}
                    aria-current={v === shown ? "true" : undefined}
                  >
                    <Link
                      href={`/companies/${companyId}/documents/${document.id}?version=${v.version}`}
                    >
                      {t("documents.version", {
                        version: v.version,
                        documentNumber:
                          v.payload.documentNumber ?? t("review.notSet"),
                        author:
                          v.author.kind === "ai"
                            ? t("review.aiAuthor", {
                                provider: v.author.provider,
                                model: v.author.model,
                              })
                            : v.author.userId === userId
                              ? t("review.userAuthorYou")
                              : t("review.userAuthor"),
                      })}
                    </Link>{" "}
                    <span className="iv-muted">
                      {v === current
                        ? t("review.currentVersionTime", {
                            time: formatDocumentDate(v.createdAt, true),
                          })
                        : formatDocumentDate(v.createdAt, true)}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </main>
      <RefreshWhile
        active={
          company.aiProcessing !== null &&
          isBeingExtracted(document.status)
        }
      />
    </>
  );
}
