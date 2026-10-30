import type { ComputedVatReport, ControlStatementEntry } from "./vat-rules";
import { isZeroRateBreakdownLine } from "./extraction-payload";

type Amounts = { netAmount: string; vatAmount: string };
export type ControlStatementPreviewData = {
  company: ComputedVatReport["company"];
  period: string;
  sections: {
    section: ControlStatementEntry["section"];
    entries: (ControlStatementEntry & { entryIndex: number })[];
    documentIds: string[];
    totals: Amounts;
  }[];
  totals: Amounts;
};

function halers(value: string): bigint {
  return BigInt(value.replace(".", ""));
}

function amount(value: bigint): string {
  const absolute = value < BigInt(0) ? -value : value;
  return `${value < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}

function totalsOf(entries: ControlStatementEntry[]): Amounts {
  const totals = entries.flatMap(entry => entry.rateBreakdown).reduce(
    (sum, rate) => ({ netAmount: sum.netAmount + halers(rate.netAmount), vatAmount: sum.vatAmount + halers(rate.vatAmount) }),
    { netAmount: BigInt(0), vatAmount: BigInt(0) },
  );
  return { netAmount: amount(totals.netAmount), vatAmount: amount(totals.vatAmount) };
}

/** Groups existing snapshot entries for presentation; statutory aggregation and
 * per-rate contributor identities remain exactly those of the saved report. */
export function controlStatementPreviewData(report: ComputedVatReport): ControlStatementPreviewData {
  const entries = report.controlStatement.map((entry, entryIndex) => ({
    ...entry, entryIndex, rateBreakdown: entry.rateBreakdown.filter(line => !isZeroRateBreakdownLine(line)),
  }));
  const order: ControlStatementEntry["section"][] = ["A.1", "A.2", "A.4", "A.5", "B.1", "B.2", "B.3"];
  return {
    company: report.company,
    period: report.period,
    sections: order.flatMap(section => {
      const grouped = entries.filter(entry => entry.section === section);
      return grouped.length ? [{ section, entries: grouped, documentIds: [...new Set(grouped.flatMap(entry => entry.documentIds))], totals: totalsOf(grouped) }] : [];
    }),
    totals: totalsOf(entries),
  };
}
