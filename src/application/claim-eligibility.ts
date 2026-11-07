import type { ExtractionPayload } from "./extraction-payload";
import type { ReportingYear } from "./companies";
import type { ValidationFinding } from "./document-validation";
import { reportingPeriodForDate, reportingPeriodStart } from "./reporting-periods";

export function ordinaryDomesticClaim(payload: ExtractionPayload): boolean {
  return payload.direction === "incoming" && payload.proposedVatRegime === "domestic"
    && ["invoice", "receipt", "simplified_tax_document"].includes(payload.documentType ?? "");
}

/** Current reporting projection; saved Versions and reports are never rewritten. */
export function claimEligibilityFinding(document: {
  payload: ExtractionPayload | null; claimedReportingPeriod?: string | null; importDate?: string | null; sourceFileId?: string | null;
}, years: readonly ReportingYear[]): ValidationFinding | null {
  const payload = document.payload;
  if (!payload || payload.direction !== "incoming") return null;
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
  if (reportingPeriodStart(document.claimedReportingPeriod ?? taxPeriod)! < earliest) return error("claimed_period_before_earliest");
  return null;
}
