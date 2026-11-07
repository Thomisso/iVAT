import type { ExtractionPayload } from "./extraction-payload";
import type { ReportingYear } from "./companies";
import type { ValidationFinding } from "./document-validation";
import { nextCzechWorkingDate } from "./epo-export-timing";
import { reportingPeriodsOf, reportingPeriodForDate, reportingPeriodStart } from "./reporting-periods";

export function ordinaryDomesticClaim(payload: ExtractionPayload): boolean {
  return payload.direction === "incoming" && payload.proposedVatRegime === "domestic"
    && ["invoice", "receipt", "simplified_tax_document"].includes(payload.documentType ?? "");
}

/** Current reporting projection; saved Versions and reports are never rewritten. */
export function claimEligibilityFinding(document: {
  payload: ExtractionPayload | null; claimedReportingPeriod?: string | null; importDate?: string | null; sourceFileId?: string | null;
}, years: readonly ReportingYear[], evaluatedOn?: string): ValidationFinding | null {
  const payload = document.payload;
  if (!payload || payload.direction !== "incoming") return null;
  if (payload.proposedVatRegime === "domestic" && !payload.documentType)
    return { field: "documentType", severity: "error", code: "claim_document_type_required" };
  const error = (code: string): ValidationFinding => ({ field: "claimEligibility", severity: "error", code });
  if (document.claimedReportingPeriod && !ordinaryDomesticClaim(payload)) return error("deferred_claim_not_supported");
  if (!ordinaryDomesticClaim(payload)) return null;
  const claim = payload.claimEligibility;
  const basis = claim?.basis;
  if (!claim?.confirmed || !basis || !["user", "same_period"].includes(claim.origin)
    || (["documentType", "direction", "proposedVatRegime", "taxPointDate", "issueDate"] as const).some(key => basis[key] !== payload[key])
    || (document.importDate !== undefined && basis.importDate !== document.importDate)
    || (document.sourceFileId !== undefined && basis.sourceFileId !== document.sourceFileId)) return error("claim_eligibility_required");
  const taxPeriod = payload.taxPointDate ? reportingPeriodForDate(payload.taxPointDate, years) : null;
  const earliest = reportingPeriodStart(claim.period);
  if (!taxPeriod || !earliest || reportingPeriodForDate(earliest, years) !== claim.period
    || earliest < reportingPeriodStart(taxPeriod)!) return error("invalid_earliest_claim_period");
  if (claim.origin === "same_period" && (claim.period !== taxPeriod
    || !payload.issueDate || reportingPeriodForDate(payload.issueDate, years) !== taxPeriod
    || !basis.importDate || reportingPeriodForDate(basis.importDate, years) !== taxPeriod)) return error("claim_eligibility_required");
  const chosen = document.claimedReportingPeriod ?? taxPeriod;
  if (reportingPeriodStart(chosen)! < earliest) return error("claimed_period_before_earliest");
  const deadline = evaluatedOn ? claimDeadline(payload, years, evaluatedOn) : null;
  if (deadline && evaluatedOn! > deadline.lastFilingDate) return { ...error("claim_deadline_expired"), params: { lastFilingDate: deadline.lastFilingDate, evaluatedOn: evaluatedOn! } };
  if (deadline && firstOrdinaryFilingDate(chosen)! > deadline.lastFilingDate) return { ...error("claimed_period_after_deadline"), params: { lastFilingDate: deadline.lastFilingDate } };
  return null;
}

export type ClaimDeadline = {
  lastFilingDate: string;
  evaluatedOn: string;
  latestOrdinaryPeriod: string | null;
};

/** First possible ordinary filing, independent of the nominal 25th-day due date. */
export function firstOrdinaryFilingDate(period: string): string | null {
  const start = reportingPeriodStart(period);
  if (!start) return null;
  return new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1 + (period.includes("-Q") ? 3 : 1), 1)).toISOString().slice(0, 10);
}

/** Projection only: write transitions independently re-evaluate the DB clock. */
export function claimDeadline(payload: ExtractionPayload | null, years: readonly ReportingYear[], evaluatedOn: string): ClaimDeadline | null {
  if (!payload || !ordinaryDomesticClaim(payload) || !payload.taxPointDate) return null;
  const origin = payload.taxPointDate;
  const originPeriod = reportingPeriodForDate(origin, years);
  if (!originPeriod) return null;
  const start = firstOrdinaryFilingDate(originPeriod)!;
  const base = origin >= "2025-01-01" ? `${Number(origin.slice(0, 4)) + 2}-12-31`
    : `${Number(start.slice(0, 4)) + 3}${start.slice(4)}`;
  const lastFilingDate = nextCzechWorkingDate(base);
  const latestOrdinaryPeriod = reportingPeriodsOf(years).filter(period => firstOrdinaryFilingDate(period)! <= lastFilingDate).at(-1) ?? null;
  return { lastFilingDate, evaluatedOn, latestOrdinaryPeriod };
}
