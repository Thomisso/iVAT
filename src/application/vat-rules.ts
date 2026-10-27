import type { CompanyDetails } from "./companies";
import type { DocumentStatus } from "./documents";
import {
  validateExtractionPayload,
  type ExtractionPayload,
} from "./extraction-payload";

export type ReportDocument = {
  id: string;
  extractionVersionId: string | null;
  status: DocumentStatus;
  payload: ExtractionPayload | null;
};
export type VatReturnLine = {
  line: "1" | "2" | "40" | "41";
  netAmount: string;
  vatAmount: string;
  documentIds: string[];
};

export type ControlStatementEntry = {
  section: "A.4" | "A.5" | "B.2" | "B.3";
  counterpartyVatId: string | null;
  documentNumber: string | null;
  taxPointDate: string | null;
  rateBreakdown: {
    rate: number;
    netAmount: string;
    vatAmount: string;
    documentIds: string[];
  }[];
  documentIds: string[];
};
export type ExclusionReason =
  | "not_approved"
  | "manual_classification_required"
  | "currency_conversion_required"
  | "incomplete_data";
export type ComputedVatReport = {
  company: CompanyDetails;
  period: string;
  vatReturn: VatReturnLine[];
  controlStatement: ControlStatementEntry[];
  totals: {
    outputVat: string;
    inputVat: string;
    payable: string;
    excessDeduction: string;
  };
  excludedDocuments: { documentId: string; reason: ExclusionReason }[];
};

export const isReportingPeriod = (value: string) =>
  /^(20\d{2})-(0[1-9]|1[0-2])$/.test(value);

/** Amounts are summed in integer halers; no financial value passes through a float. */
function halers(value: string): bigint {
  return BigInt(value.replace(".", ""));
}
function amount(value: bigint): string {
  const absolute = value < BigInt(0) ? -value : value;
  return `${value < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}
function add(
  target: { netAmount: string; vatAmount: string; documentIds: string[] },
  source: { netAmount: string; vatAmount: string },
  id: string,
) {
  target.netAmount = amount(
    halers(target.netAmount) + halers(source.netAmount),
  );
  target.vatAmount = amount(
    halers(target.vatAmount) + halers(source.vatAmount),
  );
  if (!target.documentIds.includes(id)) target.documentIds.push(id);
}

function exclusion(document: ReportDocument): ExclusionReason | null {
  if (document.status !== "approved") return "not_approved";
  const p = document.payload;
  if (
    !p ||
    validateExtractionPayload(p) ||
    !p.direction ||
    !p.documentNumber ||
    !p.taxPointDate ||
    !p.rateBreakdown.length ||
    !p.totals.grossAmount
  )
    return "incomplete_data";
  if (
    p.proposedVatRegime !== "domestic" ||
    p.rateBreakdown.some((r) => r.rate !== 21 && r.rate !== 12)
  )
    return "manual_classification_required";
  if (p.currency !== "CZK") return "currency_conversion_required";
  if (
    p.direction === "incoming" &&
    !/^CZ[0-9]{8,10}$/.test(p.supplier.vatId ?? "")
  )
    return "incomplete_data";
  return null;
}

/**
 * Domestic CZK supplies at 21% and 12%, monthly by Tax Point Date (#21).
 * Unsupported data stays visible as exclusions, never silently treated as zero.
 * Statutory mapping and the whole-Document threshold: docs/vat-rules.md.
 */
export function computeVatReport(
  company: CompanyDetails,
  period: string,
  documents: ReportDocument[],
): ComputedVatReport {
  const vatReturn: VatReturnLine[] = (["1", "2", "40", "41"] as const).map(
    (line) => ({ line, netAmount: "0.00", vatAmount: "0.00", documentIds: [] }),
  );
  const controlStatement: ControlStatementEntry[] = [];
  const excludedDocuments: ComputedVatReport["excludedDocuments"] = [];
  for (const document of documents) {
    const payload = document.payload;
    if (!payload?.taxPointDate?.startsWith(`${period}-`)) continue;
    const reason = exclusion(document);
    if (reason) {
      excludedDocuments.push({ documentId: document.id, reason });
      continue;
    }
    const p = payload;
    const vatId = (p.direction === "incoming" ? p.supplier : p.customer).vatId;
    const gross = halers(p.totals.grossAmount!);
    const individual =
      (gross < BigInt(0) ? -gross : gross) > BigInt(1000000) &&
      (p.direction === "incoming" || /^CZ[0-9]{8,10}$/.test(vatId ?? ""));
    const section =
      p.direction === "outgoing"
        ? individual
          ? "A.4"
          : "A.5"
        : individual
          ? "B.2"
          : "B.3";
    let entry = individual
      ? undefined
      : controlStatement.find((entry) => entry.section === section);
    if (!entry) {
      entry = {
        section,
        counterpartyVatId: individual ? vatId : null,
        documentNumber: individual ? p.documentNumber : null,
        taxPointDate: individual ? p.taxPointDate : null,
        rateBreakdown: [],
        documentIds: [],
      };
      controlStatement.push(entry);
    }
    entry.documentIds.push(document.id);
    for (const rate of p.rateBreakdown) {
      const line =
        p.direction === "outgoing"
          ? rate.rate === 21
            ? "1"
            : "2"
          : rate.rate === 21
            ? "40"
            : "41";
      add(
        vatReturn.find((entry) => entry.line === line)!,
        rate,
        document.id,
      );
      let breakdown = entry.rateBreakdown.find((b) => b.rate === rate.rate);
      if (!breakdown) {
        breakdown = {
          rate: rate.rate,
          netAmount: "0.00",
          vatAmount: "0.00",
          documentIds: [],
        };
        entry.rateBreakdown.push(breakdown);
      }
      add(breakdown, rate, document.id);
    }
  }
  const output =
    halers(vatReturn[0].vatAmount) + halers(vatReturn[1].vatAmount);
  const input = halers(vatReturn[2].vatAmount) + halers(vatReturn[3].vatAmount);
  return {
    company,
    period,
    vatReturn,
    controlStatement,
    excludedDocuments,
    totals: {
      outputVat: amount(output),
      inputVat: amount(input),
      payable: amount(output > input ? output - input : BigInt(0)),
      excessDeduction: amount(input > output ? input - output : BigInt(0)),
    },
  };
}
