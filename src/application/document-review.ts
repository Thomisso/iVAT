import { getCurrentDocumentReviewFindings } from "./document-review-findings";
import type { AppClient } from "./client";
import { isBankAccountFinding } from "./bank-account-checks";
import { getCompany, getMyCompanyRole, listCompanyReportingYears } from "./companies";
import { prepareDocumentReporting } from "./document-reporting";
import {
  documentPeriodLocks,
  getDocument,
  listDeferredClaimPeriods,
  listDuplicateWarnings,
  listExtractionVersions,
  readDocumentRows,
} from "./documents";
import { missingReportingPeriodFinding } from "./reporting-years";
import { getSourceFile } from "./source-files";

/**
 * Loads the review under the reader's identity. An explicit Version selects
 * its recorded findings, even when it is the latest Version. The default view
 * may supplement the current data with dated Bank Account Checks; observations
 * of another Version never replace its findings. No saved data is rewritten.
 */
export async function getDocumentReview(
  client: AppClient,
  input: { companyId: string; documentId: string; requestedVersion?: string },
) {
  const { companyId, documentId, requestedVersion } = input;
  const [company, document] = await Promise.all([
    getCompany(client, companyId),
    getDocument(client, companyId, documentId),
  ]);
  if (!company || !document) return null;

  const [versions, duplicateWarnings, missingPeriod, role, reportingYears, file, locks, deferredClaimPeriods, observations] = await Promise.all([
    listExtractionVersions(client, companyId, documentId),
    listDuplicateWarnings(client, companyId, documentId),
    missingReportingPeriodFinding(client, companyId, documentId),
    getMyCompanyRole(client, companyId),
    listCompanyReportingYears(client, companyId),
    document.sourceFileId ? getSourceFile(client, companyId, document.sourceFileId) : null,
    documentPeriodLocks(client, companyId, [documentId]),
    listDeferredClaimPeriods(client, companyId, documentId),
    getCurrentDocumentReviewFindings(client, input),
  ]);
  if (document.sourceFileId && !file) return null;

  const current = versions.at(-1);
  // Separate reads may straddle a correction. Apply observations only when
  // they describe the same immutable Version loaded for this review.
  const matchingObservations = observations.extractionVersionId === current?.id;
  const bankChecks = { checks: observations.checks, current: matchingObservations ? observations.current : null };
  const currentFindings = matchingObservations ? observations.findings : current?.findings ?? [];
  const recorded = versions.find((version) => String(version.version) === requestedVersion);
  const shown = recorded ?? current;
  const sourceRows = document.rowSet ? await readDocumentRows(client, companyId, documentId, shown?.version) : null;
  const viewingRecorded = recorded !== undefined;
  const shownFindings = viewingRecorded ? shown?.findings ?? [] : currentFindings;
  const shownWarningFindings = shownFindings.filter((finding) => finding.severity === "warning"
    && !(!viewingRecorded && bankChecks.current && isBankAccountFinding(finding)));
  const lockedPeriod = locks[documentId];
  const reporting = prepareDocumentReporting({
    id: document.id, status: document.status, extractionVersionId: current?.id ?? null,
    payload: current?.payload ?? null, claimedReportingPeriod: document.claimedReportingPeriod,
    importDate: document.importDate, sourceFileId: document.sourceFileId,
  }, reportingYears, undefined, currentFindings, observations.evaluatedOn);

  return {
    company, document, versions, current, shown, viewingRecorded, shownFindings, shownWarningFindings,
    bankChecks, displayedReviewContext: observations.displayedReviewContext, currentCounterparty: matchingObservations ? observations.counterparty : null, file, sourceRows, duplicateWarnings, missingPeriod, role, lockedPeriod,
    deferredClaimPeriods, reporting, reportingYears,
    reviewing: document.status === "needs_review" && current !== undefined && !lockedPeriod,
    recoverable: !["approved", "rejected", "needs_review"].includes(document.status) && !lockedPeriod,
    excludable: !["approved", "rejected"].includes(document.status) && !lockedPeriod,
  };
}
