import { getPhotoGroup } from "@/application/photo-groups";
import { getSourceFile } from "@/application/source-files";
import { ReviewWorkspace } from "./review-workspace";
import { ReviewGuard } from "./review-guard";
import { SourceEvidenceProvider } from "./source-evidence-context";
import { WorkbookSourceViewer } from "./workbook-source-viewer";
import { ImageSourceViewer } from "./image-source-viewer";
import { PdfSourceViewer } from "./pdf-source-viewer";
import { getDocumentReview, type DocumentApprovalDecision } from "@/application/document-review";
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
import { documentQueueQuery, getDocumentQueuePosition, hasDocumentQueueContext } from "@/application/document-queue";
import { isBeingExtracted } from "@/application/documents";
import { CommandButton } from "@/components/command-button";
import { RefreshWhile } from "@/components/refresh-while";
import { availableAuthValue, requireUserClient } from "@/lib/supabase/server";
import { DocumentViewer } from "@/components/document-viewer";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { StatusBadge } from "@/components/status-badge";
import { statusBadgeState } from "@/components/status-badge-state";
import { formatDate, formatDateTime, formatMonthName } from "@/lib/format-date";
import { emptyDocumentPayload } from "@/application/extraction-payload";
import { ExclusionForm } from "./exclusion-form";
import { CorrectionForm } from "./correction-form";
import { findingMessage } from "./finding-message";
import { ReportingAssignmentForm } from "./reporting-assignment-form";
import { reportingPeriodsOf } from "@/application/reporting-periods";
import { ordinaryDomesticClaim } from "@/application/claim-eligibility";
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
  const photoGroup = await getPhotoGroup(client, companyId, document.id);
  const groupSources = photoGroup ? await Promise.all(photoGroup.sourceFileIds.map(id => getSourceFile(client, companyId, id))) : [];
  const position = await getDocumentQueuePosition(client, companyId, document.id, search);
  const { queue, documents: queuedDocuments, index: queueIndex } = position;
  const queueQuery = hasDocumentQueueContext(search) ? documentQueueQuery(queue) : "";
  const returnTo = safeCompanyReturnTo(companyId, search.returnTo);
  const currentContext = companyPageContext(companyId, `/companies/${companyId}/documents/${documentId}`, search);
  const listHref = `/companies/${companyId}/documents${queueQuery ? `?${queueQuery}` : ""}#document-${document.id}`;
  const reviewHref = (id: string, version?: number) => {
    const query = new URLSearchParams(queueQuery);
    if (version !== undefined) query.set("version", String(version));
    return withCompanyReturnTo(companyId, `/companies/${companyId}/documents/${id}${query.size ? `?${query}` : ""}`, returnTo);
  };
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const approvalDecisionLabel = (decision: DocumentApprovalDecision) => {
    if (decision.mode === "automatic") return t("review.approvalAutomatic");
    if (decision.mode === "human" && decision.actorUserId) {
      return t(decision.actorUserId === userId ? "review.approvalHumanYou" : "review.approvalHuman");
    }
    return t("review.approvalUnknown");
  };
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
      <SourceEvidenceProvider key={viewingRecorded ? `recorded-${shown?.id}` : document.id} payload={shown?.payload ?? emptyDocumentPayload()} version={shown?.version ?? 0} versionId={shown?.id ?? ""}>
      <ReviewGuard>
      <ReviewWorkspace>
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
          {photoGroup && <ol aria-label={t("sourceFiles.photoGroupOriginals")}>
            {groupSources.map((source, index) => source && <li key={source.id}>
              {t("review.page", { page: index + 1 })} · <Link href={`/companies/${companyId}/source-files/${source.id}/content`}>{source.fileName}</Link> <small className="iv-mono">{source.sha256}</small>
            </li>)}
          </ol>}
          <p>
            {t("review.status")}:{" "}
            <StatusBadge status={statusBadgeState(document.status, "document")}>
              {t(`documentStatus.${document.status}`)}
            </StatusBadge>
          </p>
          {document.importDate && <p>
            {t("review.importDate")}: {formatDate(document.importDate)}
          </p>}
          <details className="review-secondary"><summary>{t("review.reportingContext")}</summary><DocumentReportingSummary reporting={reporting} /></details>
          {document.status === "approved" && !lockedPeriod && !viewingRecorded && (
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
          {!viewingRecorded && document.sourceFileId && document.status === "failed" && current?.author.kind !== "user" && !lockedPeriod && <CommandButton
            variant="ai"
            icon="marker"
            action={reprocessDocumentAction}
            fields={{ companyId, documentId: document.id }}
          >{t("review.retryExtraction")}</CommandButton>}
          {!viewingRecorded && document.sourceFileId && !lockedPeriod && ["failed", "needs_review", "approved"].includes(document.status) && (current?.author.kind === "user" || document.status === "approved") && <details className="review-secondary"><summary>{t("review.otherActions")}</summary><DocumentAiReplacementForm companyId={companyId} documentId={document.id} /></details>}
          {recoverable && !viewingRecorded && <CommandButton action={startManualDocumentReviewAction} fields={{ companyId, documentId: document.id }}>{t("review.takeOverManually")}</CommandButton>}
          {document.status === "rejected" && !lockedPeriod && !viewingRecorded && <CommandButton action={restoreDocumentAction} fields={{ companyId, documentId: document.id }}>{t("review.reverseExclusion")}</CommandButton>}
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
        <section className="review-original" role="region" aria-label={t("review.workspace.sourcePanel")}>
          {(photoGroup?.basis || file?.format === "pdf") && file && !document.rowSet ? <PdfSourceViewer href={contentUrl} label={file.fileName} firstPage={document.firstPage!} lastPage={document.lastPage!} /> : document.rowSet && sourceRows && file ? <WorkbookSourceViewer rows={sourceRows} label={file.fileName} /> : file && !document.rowSet && (["png", "jpeg"].includes(file.format) || file.normalizedDerivative) ? <ImageSourceViewer href={contentUrl} label={file.fileName} /> : file ? <DocumentViewer label={file.fileName}>
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
            {!lockedPeriod && !viewingRecorded && current?.author.kind === "user" && <AttachDocumentSourceForm companyId={companyId} documentId={document.id} />}
          </>}
        </section>
        <section className="review-data" role="region" aria-label={t("review.workspace.dataPanel")}>
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
              extractionVersionId={shown.id}
              requestId={randomUUID()}
              displayedBankAccountCheckId={bankChecks.current?.id ?? null}
              displayedReviewContext={review.displayedReviewContext}
              currentCounterparty={viewingRecorded ? null : review.currentCounterparty}
              decision={{ nextDocumentId: position.continuationDocumentId ?? "", queueQuery, returnTo: returnTo ?? "" }}
              payload={shown.payload}
              claimPeriods={reportingPeriodsOf(review.reportingYears)}
              reportingContext={<p>{t("documentReporting.period", { period: reporting.period ?? t("documentReporting.unassigned") })}</p>}
              findings={shownFindings}
              editable={reviewing && !viewingRecorded}
              aiProposed={
                shown.author.kind === "ai" && document.status !== "approved"
              }
            />
          ) : document.status === "needs_review" && !lockedPeriod ? (
            <CorrectionForm key={document.id} companyId={companyId} documentId={document.id} version={0} requestId={randomUUID()} displayedBankAccountCheckId={bankChecks.current?.id ?? null} decision={{ nextDocumentId: position.continuationDocumentId ?? "", queueQuery, returnTo: returnTo ?? "" }} payload={emptyDocumentPayload()} findings={[]} editable aiProposed={false} claimPeriods={reportingPeriodsOf(review.reportingYears)} reportingContext={<p>{t("documentReporting.period", { period: reporting.period ?? t("documentReporting.unassigned") })}</p>} />
          ) : (
            <EmptyState icon="file" title={t("review.noExtraction")} />
          )}
          {!viewingRecorded && current && (
            <ReportingAssignmentForm
              companyId={companyId}
              documentId={document.id}
              claimedReportingPeriod={document.claimedReportingPeriod}
              available={reviewing && (ordinaryDomesticClaim(current.payload) || !!document.claimedReportingPeriod)}
              periods={deferredClaimPeriods}
            />
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
          {excludable && !viewingRecorded && <ExclusionForm fields={{ companyId, documentId: document.id, nextDocumentId: position.continuationDocumentId ?? "", queueQuery, returnTo: returnTo ?? "" }} />}
          {versions.length > 0 && (
            <>
              <details className="review-history"><summary>{t("review.history")}</summary>
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
              </ol></details>
            </>
          )}
          {review.approvalDecisions.length > 0 && (
            <details className="review-history">
              <summary>{t("review.approvalHistory")}</summary>
              <ol>
                {review.approvalDecisions.toReversed().map((decision, index) => (
                  <li key={`${decision.occurredAt}-${index}`}>
                    {approvalDecisionLabel(decision)}{" · "}
                    {decision.version === null ? t("review.approvalVersionUnknown") : t("review.approvalVersion", { version: decision.version })}{" · "}
                    <time dateTime={decision.occurredAt}>{formatDateTime(decision.occurredAt)}</time>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </section>
      </ReviewWorkspace>
      </ReviewGuard>
      </SourceEvidenceProvider>
      <RefreshWhile
        active={
          company.aiProcessingEnabled &&
          isBeingExtracted(document.status)
        }
      />
    </>
  );
}
