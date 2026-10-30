import type { ComputedVatReport } from "./vat-rules";
import { isZeroRateBreakdownLine } from "./extraction-payload";

export type ControlStatementPreviewData = {
  company: ComputedVatReport["company"];
  period: string;
  entries: ComputedVatReport["controlStatement"];
  totals: {
    netAmount: string;
    vatAmount: string;
  };
};

function halers(value: string): bigint {
  return BigInt(value.replace(".", ""));
}

function amount(value: bigint): string {
  const absolute = value < BigInt(0) ? -value : value;
  return `${value < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(
    absolute % BigInt(100),
  ).padStart(2, "0")}`;
}

/** Selects and totals only data already stored in a VAT Report snapshot. */
export function controlStatementPreviewData(
  report: ComputedVatReport,
): ControlStatementPreviewData {
  const totals = report.controlStatement
    .flatMap((entry) => entry.rateBreakdown)
    .reduce(
      (sum, rate) => ({
        netAmount: sum.netAmount + halers(rate.netAmount),
        vatAmount: sum.vatAmount + halers(rate.vatAmount),
      }),
      { netAmount: BigInt(0), vatAmount: BigInt(0) },
    );
  return {
    company: report.company,
    period: report.period,
    entries: report.controlStatement.map((entry) => ({ ...entry, rateBreakdown: entry.rateBreakdown.filter((line) => !isZeroRateBreakdownLine(line)) })),
    totals: {
      netAmount: amount(totals.netAmount),
      vatAmount: amount(totals.vatAmount),
    },
  };
}
