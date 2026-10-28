import type {
  CompanyDetails,
  FilingFrequencyHistoryEntry,
} from "./companies";
import type { DocumentStatus } from "./documents";
import {
  validateExtractionPayload,
  type ExtractionPayload,
} from "./extraction-payload";
import {
  reportingPeriodForDate,
  reportingPeriodStart,
} from "./reporting-periods";
export { isReportingPeriod } from "./reporting-periods";

export type ReportDocument = {
  id: string;
  extractionVersionId: string | null;
  status: DocumentStatus;
  payload: ExtractionPayload | null;
  receiptDate?: string;
  claimedReportingPeriod?: string | null;
};

export type ReportingPeriodDocument = {
  direction: "incoming" | "outgoing" | null;
  taxPointDate: string | null;
  receiptDate: string;
  claimedReportingPeriod: string | null;
};

function validDate(value: string | null): value is string {
  if (!value || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}


/** Assigns a Document to the Company's Reporting Period in force on its relevant date. */
export function reportingPeriodForDocument(
  document: ReportingPeriodDocument,
  filingFrequencies: readonly FilingFrequencyHistoryEntry[],
): string | null {
  if (!validDate(document.taxPointDate)) return null;
  if (document.direction === "outgoing") {
    return reportingPeriodForDate(document.taxPointDate, filingFrequencies);
  }
  if (document.direction !== "incoming" || !validDate(document.receiptDate)) {
    return null;
  }
  const assigned = reportingPeriodForDate(
    document.receiptDate > document.taxPointDate
      ? document.receiptDate
      : document.taxPointDate,
    filingFrequencies,
  );
  const claimedStart = document.claimedReportingPeriod
    ? reportingPeriodStart(document.claimedReportingPeriod)
    : null;
  if (
    assigned &&
    claimedStart &&
    reportingPeriodForDate(claimedStart, filingFrequencies) ===
      document.claimedReportingPeriod &&
    claimedStart > reportingPeriodStart(assigned)!
  ) {
    return document.claimedReportingPeriod;
  }
  return assigned;
}
export const VAT_RETURN_LINES = [
  "1", "2", "3", "4", "5", "6", "10", "11", "25", "40", "41", "43", "44",
] as const;
export type VatReturnLineNumber = (typeof VAT_RETURN_LINES)[number];
export type VatReturnLine = {
  line: VatReturnLineNumber;
  netAmount: string;
  vatAmount: string;
  documentIds: string[];
};

export type ControlStatementEntry = {
  section: "A.1" | "A.2" | "A.4" | "A.5" | "B.1" | "B.2" | "B.3";
  counterpartyVatId: string | null;
  counterpartyCountry: string | null;
  documentNumber: string | null;
  taxPointDate: string | null;
  reverseChargeCode: string | null;
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
  totalDocumentIds: Record<keyof ComputedVatReport["totals"], string[]>;
  excludedDocuments: { documentId: string; reason: ExclusionReason }[];
};

/** Amounts are summed in integer halers; no financial value passes through a float. */
function halers(value: string): bigint {
  return BigInt(value.replace(".", ""));
}
function amount(value: bigint): string {
  const absolute = value < BigInt(0) ? -value : value;
  return `${value < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}
function assessedVat(netAmount: string, rate: number): string {
  const numerator = halers(netAmount) * BigInt(rate);
  const absolute = numerator < BigInt(0) ? -numerator : numerator;
  const rounded = (absolute + BigInt(50)) / BigInt(100);
  return amount(numerator < BigInt(0) ? -rounded : rounded);
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
  const regime = p.proposedVatRegime;
  if (
    !regime ||
    regime === "other" ||
    p.rateBreakdown.some((r) => r.rate !== 21 && r.rate !== 12) ||
    ((regime === "eu_acquisition_of_goods" || regime === "eu_received_service") &&
      p.direction !== "incoming")
  )
    return "manual_classification_required";
  if (regime === "domestic_reverse_charge" && !/^\d{1,3}$/.test(p.reverseChargeCode ?? "")) {
    return "incomplete_data";
  }
  if (
    p.currency !== "CZK" &&
    (!p.czkConversion ||
      p.czkConversion.originalCurrency !== p.currency ||
      p.czkConversion.rateDate > p.taxPointDate)
  ) return "currency_conversion_required";
  const counterparty = p.direction === "incoming" ? p.supplier : p.customer;
  if (
    (regime === "domestic_reverse_charge" &&
      !/^CZ[0-9]{8,10}$/.test(counterparty.vatId ?? "")) ||
    ((regime === "eu_acquisition_of_goods" || regime === "eu_received_service") &&
      !/^[A-Z]{2}[A-Z0-9+*.]{2,12}$/.test(p.supplier.vatId ?? "")) ||
    (regime === "domestic" &&
      p.direction === "incoming" &&
      !/^CZ[0-9]{8,10}$/.test(p.supplier.vatId ?? ""))
  ) return "incomplete_data";
  return null;
}

function czkPayload(payload: ExtractionPayload): ExtractionPayload {
  if (payload.currency === "CZK" || !payload.czkConversion) return payload;
  return {
    ...payload,
    currency: "CZK",
    rateBreakdown: payload.czkConversion.rateBreakdown,
    totals: payload.czkConversion.totals,
  };
}

function returnLines(
  payload: ExtractionPayload,
  rate: number,
): VatReturnLineNumber[] {
  const reduced = rate === 12;
  switch (payload.proposedVatRegime) {
    case "domestic":
      return [payload.direction === "outgoing" ? (reduced ? "2" : "1") : reduced ? "41" : "40"];
    case "domestic_reverse_charge":
      return payload.direction === "outgoing"
        ? ["25"]
        : [reduced ? "11" : "10", reduced ? "44" : "43"];
    case "eu_acquisition_of_goods":
      return [reduced ? "4" : "3", reduced ? "44" : "43"];
    case "eu_received_service":
      return [reduced ? "6" : "5", reduced ? "44" : "43"];
    default:
      return [];
  }
}

const OUTPUT_LINES = new Set<VatReturnLineNumber>(["1", "2", "3", "4", "5", "6", "10", "11"]);
const INPUT_LINES = new Set<VatReturnLineNumber>(["40", "41", "43", "44"]);

/**
 * Supported Czech VAT regimes at 21% and 12%, in the assigned Reporting Period.
 * Unsupported data stays visible as exclusions, never silently treated as zero.
 * Statutory mapping and the whole-Document threshold: docs/vat-rules.md.
 */
export function computeVatReport(
  company: CompanyDetails,
  period: string,
  documents: ReportDocument[],
  filingFrequencies: readonly FilingFrequencyHistoryEntry[] = [
    { frequency: "monthly", effectiveFrom: "2000-01-01" },
  ],
): ComputedVatReport {
  const vatReturn: VatReturnLine[] = VAT_RETURN_LINES.map(
    (line) => ({ line, netAmount: "0.00", vatAmount: "0.00", documentIds: [] }),
  );
  const controlStatement: ControlStatementEntry[] = [];
  const excludedDocuments: ComputedVatReport["excludedDocuments"] = [];
  for (const document of documents) {
    const payload = document.payload;
    const assignedPeriod = payload
      ? reportingPeriodForDocument(
          {
            direction: payload.direction,
            taxPointDate: payload.taxPointDate,
            receiptDate: document.receiptDate ?? payload.taxPointDate ?? "",
            claimedReportingPeriod: document.claimedReportingPeriod ?? null,
          },
          filingFrequencies,
        ) ??
        (/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(payload.taxPointDate ?? "")
          ? reportingPeriodForDate(
              `${payload.taxPointDate!.slice(0, 7)}-01`,
              filingFrequencies,
            )
          : null)
      : null;
    if (
      !payload ||
      assignedPeriod !== period
    ) continue;
    const reason = exclusion(document);
    if (reason) {
      excludedDocuments.push({ documentId: document.id, reason });
      continue;
    }
    const p = czkPayload(payload);
    const counterparty = p.direction === "incoming" ? p.supplier : p.customer;
    const vatId = counterparty.vatId;
    const domestic = p.proposedVatRegime === "domestic";
    const gross = halers(p.totals.grossAmount!);
    const individualDomestic =
      domestic &&
      (gross < BigInt(0) ? -gross : gross) > BigInt(1000000) &&
      (p.direction === "incoming" || /^CZ[0-9]{8,10}$/.test(vatId ?? ""));
    const section: ControlStatementEntry["section"] =
      p.proposedVatRegime === "domestic_reverse_charge"
        ? p.direction === "outgoing" ? "A.1" : "B.1"
        : p.proposedVatRegime === "eu_acquisition_of_goods" ||
            p.proposedVatRegime === "eu_received_service"
          ? "A.2"
          : p.direction === "outgoing"
            ? individualDomestic ? "A.4" : "A.5"
            : individualDomestic ? "B.2" : "B.3";
    const individual = !domestic || individualDomestic;
    let entry = individual
      ? undefined
      : controlStatement.find((entry) => entry.section === section);
    if (!entry) {
      entry = {
        section,
        counterpartyVatId: individual ? vatId : null,
        counterpartyCountry: section === "A.2" ? p.supplier.country : null,
        documentNumber: individual ? p.documentNumber : null,
        taxPointDate: individual ? p.taxPointDate : null,
        reverseChargeCode:
          p.proposedVatRegime === "domestic_reverse_charge"
            ? p.reverseChargeCode
            : null,
        rateBreakdown: [],
        documentIds: [],
      };
      controlStatement.push(entry);
    }
    entry.documentIds.push(document.id);
    for (const rate of p.rateBreakdown) {
      const selfAssessed = p.proposedVatRegime !== "domestic";
      const calculatedVat = selfAssessed
        ? assessedVat(rate.netAmount, rate.rate)
        : rate.vatAmount;
      for (const line of returnLines(p, rate.rate)) {
        add(
          vatReturn.find((entry) => entry.line === line)!,
          {
            netAmount: rate.netAmount,
            vatAmount: line === "25" ? "0.00" : calculatedVat,
          },
          document.id,
        );
      }
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
      add(
        breakdown,
        {
          netAmount: rate.netAmount,
          vatAmount:
            section === "A.1" ? "0.00" : calculatedVat,
        },
        document.id,
      );
    }
  }
  const output = vatReturn
    .filter((line) => OUTPUT_LINES.has(line.line))
    .reduce((sum, line) => sum + halers(line.vatAmount), BigInt(0));
  const input = vatReturn
    .filter((line) => INPUT_LINES.has(line.line))
    .reduce((sum, line) => sum + halers(line.vatAmount), BigInt(0));
  const outputIds = [
    ...new Set(vatReturn.filter((line) => OUTPUT_LINES.has(line.line)).flatMap((r) => r.documentIds)),
  ];
  const inputIds = [
    ...new Set(vatReturn.filter((line) => INPUT_LINES.has(line.line)).flatMap((r) => r.documentIds)),
  ];
  const allIds = [...new Set([...outputIds, ...inputIds])];
  return {
    totalDocumentIds: {
      outputVat: outputIds,
      inputVat: inputIds,
      payable: allIds,
      excessDeduction: allIds,
    },
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
