import type { ComputedVatReport } from "./vat-rules";

export type VatReturnPreviewData = {
  company: ComputedVatReport["company"];
  period: string;
  lines: ComputedVatReport["vatReturn"];
  totals: ComputedVatReport["totals"];
};

/** The saved VAT Return data shared by the on-screen preview and its PDF. */
export function vatReturnPreviewData(
  report: ComputedVatReport,
): VatReturnPreviewData {
  return {
    company: report.company,
    period: report.period,
    lines: report.vatReturn,
    totals: report.totals,
  };
}
