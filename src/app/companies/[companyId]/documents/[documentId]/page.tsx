import { getDocumentReview } from "@/application/document-review";
import Link from "next/link";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import {
  refreshBankAccountCheckAction,
  startManualDocumentReviewAction,
  restoreDocumentAction,
  reprocessDocumentAction,
  returnDocumentToReviewAction,
} from "@/app/actions";
import { DocumentReportingSummary } from "@/components/document-reporting-summary";
import { currentUserId } from "@/application/auth";
import { documentQueueQuery, getDocumentQueuePosition } from "@/application/document-queue";
import { isBeingExtracted } from "@/application/documents";
import { CommandButton } from "@/components/command-button";
import { RefreshWhile } from "@/components/refresh-while";
import { availableAuthValue, requireUserClient } from "@/lib/supabase/server";
import { DocumentViewer } from "@/components/document-viewer";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { StatusBadge } from "@/components/status-badge";
import { statusBadgeState } from "@/components/status-badge-state";
import { PageLayout } from "@/components/app-shell";
import { formatDate, formatDateTime, formatMonthName } from "@/lib/format-date";
import { emptyDocumentPayload } from "@/application/extraction-payload";
import { ExclusionForm } from "./exclusion-form";
import { CorrectionForm } from "./correction-form";
import { findingMessage } from "./finding-message";
import { ReportingAssignmentForm } from "./reporting-assignment-form";
import { companyPageContext, safeCompanyReturnTo, withCompanyReturnTo } from "@/application/return-context";
import { AttachDocumentSourceForm, DocumentAiReplacementForm } from "./source-attachment-form";
import { CompanyReturnLink } from "@/components/company-return-link";

// The review workspace: the Document's original pages next to its extracted
// data. `?version=N` shows an earlier Extraction Version read-only.
export default async function DocumentReviewPage({
  params,
  searchParams,
}: PageProps<"/companies/[companyId]/documents/[documentId]">) {
  const { companyId, documentId } = await params;
  const search = await searchParams;
  const requestedVersion = typeof search.version === "string" ? search.version : undefined;
  const client = await requireUserClient();
  const [review, userId] = await Promise.all([
    getDocumentReview(client, { companyId, documentId, requestedVersion }),
    currentUserId(client).then(availableAuthValue),
  ]);
  if (!review) notFound();
  const {
    company, document, versions, current, shown, viewingRecorded, shownFindings, shownWarningFindings,
    bankChecks, file, sourceRows, duplicateWarnings, missingPeriod, role, lockedPeriod,
    deferredClaimPeriods, reporting, reviewing, recoverable, excludable,
  } = review;
  const position = await getDocumentQueuePosition(client, companyId, document.id, search);
  const { queue, documents: queuedDocuments, index: queueIndex } = position;
  const queueQuery = documentQueueQuery(queue);
  const returnTo = safeCompanyReturnTo(companyId, search.returnTo);
  const currentContext = companyPageContext(companyId, `/companies/${companyId}/documents/${documentId}`, search);
  const listHref = `/companies/${companyId}/documents?${queueQuery}#document-${document.id}`;
  const reviewHref = (id: string, version?: number) => {
    const query = new URLSearchParams(queueQuery);
    if (version !== undefined) query.set("version", String(version));
    return withCompanyReturnTo(companyId, `/companies/${companyId}/documents/${id}?${query}`, returnTo);
  };
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const contentUrl = file?.normalizedDerivative
    ? `/companies/${companyId}/source-files/${file.id}/preview`
    : `/companies/${companyId}/documents/${document.id}/content`;
  const sourceLocation = document.rowSet
    ? document.rowSet.firstRow === document.rowSet.lastRow
      ? t("review.row", { sheet: document.rowSet.sheetName, row: document.rowSet.firstRow })
      : t("review.rowRange", {
          sheet: document.rowSet.sheetName,
          first: document.rowSet.firstRow,
          last: document.rowSet.lastRow,
        })
    : document.firstPage === null || document.lastPage === null ? null
    : document.firstPage === document.lastPage
      ? t("review.page", { page: document.firstPage })
      : t("review.pageRange", { first: document.firstPage, last: document.lastPage });

  return (
    <>
      <PageLayout className="review" measure="wide">
        <header className="review-header">
          <nav className="review-queue-nav" aria-label={t("review.queueNavigation")}>
            <CompanyReturnLink companyId={companyId} returnTo={returnTo} fallback={queueIndex >= 0 ? listHref : `/companies/${companyId}/documents`} />
            {queueIndex >= 0 && <span>{t("review.queuePosition", { current: queueIndex + 1, total: queuedDocuments.length })}</span>}
            {queueIndex >= 0 && <span className="review-queue-steps">
              {position.previousDocumentId ? <Link href={reviewHref(position.previousDocumentId)}>{t("review.previous")}</Link> : <span aria-disabled="true">{t("review.previous")}</span>}
              {position.nextDocumentId ? <Link href={reviewHref(position.nextDocumentId)}>{t("review.next")}</Link> : <span aria-disabled="true">{t("review.next")}</span>}
            </span>}
          </nav>
          <h1>
            {t("review.title")}
            {current?.payload.documentNumber && (
              <span className="iv-mono"> {current.payload.documentNumber}</span>
            )}
          </h1>
          {file && sourceLocation ? <p className="iv-muted">
            <Link href={withCompanyReturnTo(companyId, `/companies/${companyId}/source-files/${file.id}`, currentContext)}>
              {t("review.sourceFile", { fileName: file.fileName, pages: sourceLocation })}
            </Link>
          </p> : <p className="iv-muted">{t("review.manualDocument")}</p>}
          <p>
            {t("review.status")}:{" "}
            <StatusBadge status={statusBadgeState(document.status, "document")}>
              {t(`documentStatus.${document.status}`)}
            </StatusBadge>
          </p>
          {document.importDate && <p>
            {t("review.importDate")}: {formatDate(document.importDate)}
          </p>}
          <DocumentReportingSummary reporting={reporting} />
          {document.status === "approved" && !lockedPeriod && (
            <CommandButton
              action={returnDocumentToReviewAction}
              fields={{ companyId, documentId: document.id }}
            >
              {t("review.returnToReview")}
            </CommandButton>
          )}
          {document.status === "rejected" && (
            <Notice>{t("review.rejectedNote")}{document.exclusion && <p>{document.exclusion.reason} · {t(document.exclusion.userId === userId ? "review.userAuthorYou" : "review.userAuthor")} · {formatDateTime(document.exclusion.at)}</p>}</Notice>
          )}
          {lockedPeriod && <Notice tone="warning" title={t("review.lockedTitle", { period: lockedPeriod })}>{t("review.lockedNote")}</Notice>}
          {document.sourceFileId && document.status === "failed" && current?.author.kind !== "user" && !lockedPeriod && <CommandButton
            variant="ai"
            icon="marker"
            action={reprocessDocumentAction}
            fields={{ companyId, documentId: document.id }}
          >{t("review.retryExtraction")}</CommandButton>}
          {document.sourceFileId && !lockedPeriod && ["failed", "needs_review", "approved"].includes(document.status) && (current?.author.kind === "user" || document.status === "approved") && <DocumentAiReplacementForm companyId={companyId} documentId={document.id} />}
          {recoverable && <CommandButton action={startManualDocumentReviewAction} fields={{ companyId, documentId: document.id }}>{t("review.takeOverManually")}</CommandButton>}
          {document.status === "rejected" && !lockedPeriod && <CommandButton action={restoreDocumentAction} fields={{ companyId, documentId: document.id }}>{t("review.reverseExclusion")}</CommandButton>}
          {missingPeriod && (
            <Notice tone="danger">
              {t(`review.findings.${missingPeriod.code}`, {
                ...missingPeriod.params,
                month: missingPeriod.params?.month
                  ? formatMonthName(locale, Number(missingPeriod.params.month))
                  : "",
              })}{" "}
              {role === "administrator" && missingPeriod.code === "reporting_year_missing" && (
                <Link href={`/companies/${companyId}/settings/vat?generateYear=${missingPeriod.params?.year}#reporting-years`}>
                  {t("review.generateReportingYear", { year: missingPeriod.params?.year ?? "" })}
                </Link>
              )}
            </Notice>
          )}
          {duplicateWarnings.map((warning) => (
            <Notice key={`${warning.kind}-${warning.matchedDocumentId}`} tone="warning">
              {t(`duplicateWarning.${warning.kind}`)}{" "}
              <Link href={withCompanyReturnTo(companyId, `/companies/${companyId}/documents/${warning.matchedDocumentId}`, currentContext)}>
                {t("duplicateWarning.openMatch")}
              </Link>
            </Notice>
          ))}
        </header>
        <section className="review-original">
          {file ? <DocumentViewer label={file.fileName}>
            {document.rowSet ? (
              <div className="workbook-source">
                <Notice>{t("review.noDocumentImage")}</Notice>
                <pre tabIndex={0}>{sourceRows?.text}</pre>
              </div>
            ) : file.format === "pdf" ? (
              <iframe src={contentUrl} title={file.fileName} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- the original is shown as stored, not optimized
              <img src={contentUrl} alt={file.fileName} />
            )}
          </DocumentViewer> : <>
            <EmptyState icon="file" title={t("review.noSourceFile")} />
            {!lockedPeriod && current?.author.kind === "user" && <AttachDocumentSourceForm companyId={companyId} documentId={document.id} />}
          </>}
        </section>
        <section className="review-data">
          {shown && current && viewingRecorded && (
            <Notice>
              {t(shown === current ? "bankAccountCheck.viewingRecordedVersion" : "review.viewingOld", {
                version: shown.version,
                current: current.version,
              })}{" "}
              <Link href={reviewHref(document.id)}>
                {t("review.showCurrent")}
              </Link>
            </Notice>
          )}
          {shown && current && !viewingRecorded && (
            <section aria-label={t("bankAccountCheck.title")}>
              <h2>{t("bankAccountCheck.title")}</h2>
              <p>{t("bankAccountCheck.currentInformation")}</p>
              {bankChecks.current ? (
                <Notice tone={bankChecks.current.outcome === "published" ? "info" : "warning"}>
                  {t(`bankAccountCheck.${bankChecks.current.direction === "outgoing" ? "ownOutcomes" : "outcomes"}.${bankChecks.current.outcome}`)}{" "}
                  {t("bankAccountCheck.checkedAt", { time: formatDateTime(bankChecks.current.checkedAt) })}
                </Notice>
              ) : <p>{t("bankAccountCheck.notRefreshed")}</p>}
              <CommandButton action={refreshBankAccountCheckAction} fields={{ companyId, documentId }}>
                {t("bankAccountCheck.refresh")}
              </CommandButton>
              {bankChecks.checks.length > 0 && <details>
                <summary>{t("bankAccountCheck.history")}</summary>
                <ol>
                  {bankChecks.checks.map((check) => <li key={check.id}>
                    {t("bankAccountCheck.checkedAt", { time: formatDateTime(check.checkedAt) })}{" · "}
                    {t(`bankAccountCheck.${check.direction === "outgoing" ? "ownOutcomes" : "outcomes"}.${check.outcome}`)}{" · "}
                    {t("bankAccountCheck.inputs", { supplier: check.supplierVatId ?? t("review.notSet"), account: [check.payment.bankAccount, check.payment.iban].filter(Boolean).join(" / ") || t("review.notSet") })}{" · "}
                    <Link href={reviewHref(document.id, check.version)}>{t("bankAccountCheck.version", { version: check.version })}</Link>
                    {check.extractionVersionId !== current.id && <> · {t("bankAccountCheck.olderData")}</>}
                  </li>)}
                </ol>
              </details>}
            </section>
          )}
          {shownWarningFindings.map((finding) => (
            <Notice
              key={`${finding.field}-${finding.code}`}
              tone="warning"
            >
              {t(
                `review.findings.${findingMessage(finding).key}`,
                findingMessage(finding).values,
              )}
            </Notice>
          ))}
          {shown ? (
            <CorrectionForm
              key={viewingRecorded ? shown.id : document.id}
              companyId={companyId}
              documentId={document.id}
              version={shown.version}
              requestId={randomUUID()}
              displayedBankAccountCheckId={bankChecks.current?.id ?? null}
              decision={{ nextDocumentId: position.continuationDocumentId ?? "", queueQuery, returnTo: returnTo ?? "" }}
              payload={shown.payload}
              findings={shownFindings}
              editable={reviewing && !viewingRecorded}
              aiProposed={
                shown.author.kind === "ai" && document.status !== "approved"
              }
            />
          ) : document.status === "needs_review" && !lockedPeriod ? (
            <CorrectionForm companyId={companyId} documentId={document.id} version={0} requestId={randomUUID()} displayedBankAccountCheckId={bankChecks.current?.id ?? null} decision={{ nextDocumentId: position.continuationDocumentId ?? "", queueQuery, returnTo: returnTo ?? "" }} payload={emptyDocumentPayload()} findings={[]} editable aiProposed={false} />
          ) : (
            <EmptyState icon="file" title={t("review.noExtraction")} />
          )}
          {current?.payload.direction === "incoming" && (
            <ReportingAssignmentForm
              companyId={companyId}
              documentId={document.id}
              claimedReportingPeriod={document.claimedReportingPeriod}
              periods={deferredClaimPeriods}
            />
          )}
          {excludable && <ExclusionForm fields={{ companyId, documentId: document.id, nextDocumentId: position.continuationDocumentId ?? "", queueQuery, returnTo: returnTo ?? "" }} />}
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
                      href={reviewHref(document.id, v.version)}
                    >
                      {t("documents.version", {
                        version: v.version,
                        documentNumber:
                          v.payload.documentNumber ?? t("review.notSet"),
                        author:
                          v.author.kind === "ai"
                            ? t("review.aiAuthor")
                            : v.author.userId === userId
                              ? t("review.userAuthorYou")
                              : t("review.userAuthor"),
                      })}
                    </Link>{" "}
                    <span className="iv-muted">
                      {v === current
                        ? t("review.currentVersionTime", {
                            time: formatDateTime(v.createdAt),
                          })
                        : formatDateTime(v.createdAt)}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </PageLayout>
      <RefreshWhile
        active={
          company.aiProcessingEnabled &&
          isBeingExtracted(document.status)
        }
      />
    </>
  );
}
