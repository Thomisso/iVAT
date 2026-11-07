import type { ReportingYear } from "./companies";
import { claimDeadline, claimEligibilityFinding, type ClaimDeadline } from "./claim-eligibility";
import type { AppClient } from "./client";
import { currentValidationFindings, type ValidationFinding } from "./document-validation";
import { omitZeroRateBreakdownRows } from "./extraction-payload";
import { deriveDocumentVatMapping, missingRequiredReportingVatId, reportingPeriodForReportDocument, vatReportDocumentExclusion, type DocumentVatMapping, type ExclusionReason, type ReportDocument } from "./vat-rules";

export type DocumentReporting = {
  claimDeadline: ClaimDeadline | null;
  period: string | null;
  included: boolean;
  exclusionReason: ExclusionReason | "no_reporting_period" | "different_reporting_period" | "rejected" | null;
  exclusionDetail: "counterparty_vat_id_required" | null;
  mapping: DocumentVatMapping;
  blockingFindings: ValidationFinding[];
  advisoryFindings: ValidationFinding[];
};

/** Bounded batches stay below the configured PostgREST cap; no per-row queries. */
export async function loadStoredDocumentFindings(client: AppClient, documents: readonly ReportDocument[]) {
  const ids = [...new Set(documents.flatMap(document => document.extractionVersionId ? [document.extractionVersionId] : []))];
  const result = new Map<string, ValidationFinding[]>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const { data, error } = await client.from("extraction_version").select("id, findings").in("id", ids.slice(offset, offset + 100));
    if (error) throw error;
    for (const version of data) result.set(version.id, version.findings as ValidationFinding[]);
  }
  return result;
}

/** Current rules and current version; this never reads or rewrites a saved report. */
export function prepareDocumentReporting(
  document: ReportDocument,
  reportingYears: readonly ReportingYear[],
  selectedPeriod?: string,
  storedFindings: readonly ValidationFinding[] = [],
  evaluatedOn?: string,
): DocumentReporting {
  const payload = document.payload ? omitZeroRateBreakdownRows(document.payload) : null;
  const period = reportingPeriodForReportDocument({ ...document, payload }, reportingYears);
  const exclusionReason = document.status === "rejected" ? "rejected"
    : period === null ? "no_reporting_period"
    : selectedPeriod && selectedPeriod !== period ? "different_reporting_period"
    : vatReportDocumentExclusion({ ...document, payload });
  const eligibility = claimEligibilityFinding(document, reportingYears, evaluatedOn);
  const findings = [...(payload ? currentValidationFindings(payload, storedFindings).filter(finding => finding.code !== eligibility?.code) : []), ...(eligibility ? [eligibility] : [])];
  return {
    claimDeadline: evaluatedOn ? claimDeadline(payload, reportingYears, evaluatedOn) : null,
    period, included: exclusionReason === null, exclusionReason,
    exclusionDetail: exclusionReason === "incomplete_data" && payload && missingRequiredReportingVatId(payload) ? "counterparty_vat_id_required" : null,
    mapping: deriveDocumentVatMapping(payload),
    blockingFindings: findings.filter(finding => finding.severity === "error"),
    advisoryFindings: findings.filter(finding => finding.severity === "warning"),
  };
}
