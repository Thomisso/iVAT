import { halers, amount, assessedVat } from "./money";
import { partialClaimRates } from "./partial-claim";
import { convertedAmount } from "./exchange-rates";
import type {
  CompanyDetails,
  ReportingYear,
} from "./companies";
import type { DocumentStatus } from "./documents";
import {
  validateExtractionPayload,
  omitZeroRateBreakdownRows,
  isZeroRateBreakdownLine,
  type ExtractionPayload,
  type RateBreakdownLine,
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
  claimedReportingPeriod?: string | null;
  importDate?: string | null;
  sourceFileId?: string | null;
};

export type ReportingPeriodDocument = {
  direction: "incoming" | "outgoing" | null;
  taxPointDate: string | null;
  claimedReportingPeriod: string | null;
};

function validDate(value: string | null): value is string {
  if (!value || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}


/**
 * Assigns a Document to the Company's Reporting Period of its Tax Point Date
 * (ADR-0012), or to an incoming Document's later Deferred Claim. Mirrors
 * `private.document_reporting_period` in the database.
 */
export function reportingPeriodForDocument(
  document: ReportingPeriodDocument,
  reportingYears: readonly ReportingYear[],
): string | null {
  if (!validDate(document.taxPointDate)) return null;
  const assigned = reportingPeriodForDate(document.taxPointDate, reportingYears);
  if (document.direction !== "incoming") return assigned;
  const claimedStart = document.claimedReportingPeriod
    ? reportingPeriodStart(document.claimedReportingPeriod)
    : null;
  if (
    assigned &&
    claimedStart &&
    reportingPeriodForDate(claimedStart, reportingYears) ===
      document.claimedReportingPeriod &&
    claimedStart > reportingPeriodStart(assigned)! &&
    claimedStart <= `${Number(document.taxPointDate.slice(0, 4)) + 3}${document.taxPointDate.slice(4)}`
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

/** The stored CZK gross amount used by both domestic identity and classification. */
function reportingGrossAmountCzk(p: ExtractionPayload): string | null {
  const converted = p.currency === "CZK" ? p : p.czkConversion
    && p.czkConversion.originalCurrency === p.currency && p.taxPointDate
    && p.czkConversion.rateDate <= p.taxPointDate ? p.czkConversion : null;
  const gross = converted?.totals.grossAmount;
  return gross && /^-?\d+\.\d{2}$/.test(gross) ? gross : null;
}

/** Ordinary domestic Documents at or below the absolute CZK 10,000 gross limit. */
export function domesticCounterpartyVatIdOptional(p: ExtractionPayload): boolean {
  const gross = reportingGrossAmountCzk(p);
  if (p.proposedVatRegime !== "domestic" || gross === null) return false;
  const cents = halers(gross);
  return (cents < BigInt(0) ? -cents : cents) <= BigInt(1000000);
}

/** Mandatory counterparty identity, using the same domestic threshold as review. */
export function missingRequiredReportingVatId(p: ExtractionPayload): boolean {
  if (!p.direction) return false;
  const counterparty = p.direction === "incoming" ? p.supplier : p.customer;
  return (p.proposedVatRegime === "domestic_reverse_charge" && !/^CZ[0-9]{8,10}$/.test(counterparty.vatId ?? ""))
    || (p.direction === "incoming" && (p.proposedVatRegime === "eu_acquisition_of_goods" || p.proposedVatRegime === "eu_received_service")
      && !/^[A-Z]{2}[A-Z0-9+*.]{2,12}$/.test(p.supplier.vatId ?? ""))
    || (p.proposedVatRegime === "domestic" && (
      (!counterparty.vatId && !domesticCounterpartyVatIdOptional(p))
      || (p.direction === "incoming" && !!p.supplier.vatId && !/^CZ[0-9]{8,10}$/.test(p.supplier.vatId))));
}

export function vatReportDocumentExclusion(document: ReportDocument): ExclusionReason | null {
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
  if (p.partialClaim !== undefined && !reportingClaimRates(p)) return "incomplete_data";
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
  if (missingRequiredReportingVatId(p)) return "incomplete_data";
  return null;
}

type CompleteExtractionPayload = Omit<ExtractionPayload, "rateBreakdown"> & { rateBreakdown: RateBreakdownLine[] };

/** The selection stays in source currency; output uses the full Document's fixing. */
function reportingClaimRates(payload: ExtractionPayload): RateBreakdownLine[] | null {
  const selected = partialClaimRates(payload);
  if (!selected || payload.currency === "CZK") return selected;
  const conversion = payload.czkConversion;
  if (!conversion || conversion.originalCurrency !== payload.currency || !payload.taxPointDate
    || conversion.rateDate > payload.taxPointDate) return null;
  const converted = selected.map(line => ({
    rate: line.rate, netAmount: convertedAmount(line.netAmount, conversion), vatAmount: convertedAmount(line.vatAmount, conversion),
  }));
  return converted.some(line => line.netAmount === null || line.vatAmount === null) ? null : converted as RateBreakdownLine[];
}

function czkPayload(payload: CompleteExtractionPayload): CompleteExtractionPayload {
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

export type MappingUnknownReason = "missing_payload" | "missing_regime" | "missing_direction" | "unsupported_regime" | "missing_rate" | "unsupported_rate" | "missing_gross_amount" | "missing_currency" | "currency_conversion_required";
export type DocumentVatMapping = {
  vatReturnLines: VatReturnLineNumber[];
  controlStatementSection: ControlStatementEntry["section"] | null;
  vatReturnUnknownReason: MappingUnknownReason | null;
  controlStatementUnknownReason: MappingUnknownReason | null;
};

/** Derives classification only, never amounts, approval or report membership. */
export function deriveDocumentVatMapping(payload: ExtractionPayload | null): DocumentVatMapping {
  const unavailable = (reason: MappingUnknownReason): DocumentVatMapping => ({
    vatReturnLines: [], controlStatementSection: null, vatReturnUnknownReason: reason, controlStatementUnknownReason: reason,
  });
  if (!payload) return unavailable("missing_payload");
  const p = omitZeroRateBreakdownRows(payload);
  if (!p.proposedVatRegime) return unavailable("missing_regime");
  if (!p.direction) return unavailable("missing_direction");
  if (p.proposedVatRegime === "other" ||
    ((p.proposedVatRegime === "eu_acquisition_of_goods" || p.proposedVatRegime === "eu_received_service") && p.direction !== "incoming")) {
    return unavailable("unsupported_regime");
  }
  const vatReturnUnknownReason = !p.rateBreakdown.length || p.rateBreakdown.some(rate => rate.rate === null)
    ? "missing_rate" : p.rateBreakdown.some(rate => rate.rate !== 21 && rate.rate !== 12) ? "unsupported_rate" : null;
  const derivedLines = new Set(vatReturnUnknownReason ? [] : p.rateBreakdown.flatMap(rate => returnLines(p, rate.rate!)));
  const vatReturnLines = VAT_RETURN_LINES.filter(line => derivedLines.has(line));
  const domestic = p.proposedVatRegime === "domestic";
  let section: ControlStatementEntry["section"] | null = null;
  let controlStatementUnknownReason: MappingUnknownReason | null = null;
  if (p.proposedVatRegime === "domestic_reverse_charge") section = p.direction === "outgoing" ? "A.1" : "B.1";
  else if (!domestic) section = "A.2";
  else {
    const converted = p.currency === "CZK" ? p : p.czkConversion
      && p.czkConversion.originalCurrency === p.currency && p.taxPointDate
      && p.czkConversion.rateDate <= p.taxPointDate ? p.czkConversion : null;
    const grossAmount = converted?.totals.grossAmount;
    if (!p.currency) controlStatementUnknownReason = "missing_currency";
    else if (!converted) controlStatementUnknownReason = "currency_conversion_required";
    else if (!grossAmount || !/^-?\d+\.\d{2}$/.test(grossAmount)) controlStatementUnknownReason = "missing_gross_amount";
    else {
      const vatId = (p.direction === "incoming" ? p.supplier : p.customer).vatId;
      const individual = !domesticCounterpartyVatIdOptional(p)
        && (p.direction === "incoming" || /^CZ[0-9]{8,10}$/.test(vatId ?? ""));
      section = p.direction === "outgoing" ? individual ? "A.4" : "A.5" : individual ? "B.2" : "B.3";
    }
  }
  return { vatReturnLines, controlStatementSection: section, vatReturnUnknownReason, controlStatementUnknownReason };
}

const OUTPUT_LINES = new Set<VatReturnLineNumber>(["1", "2", "3", "4", "5", "6", "10", "11"]);
const INPUT_LINES = new Set<VatReturnLineNumber>(["40", "41", "43", "44"]);

/** Preserves the engine's assignment of malformed legacy dates for exclusion. */
export function reportingPeriodForReportDocument(document: ReportDocument, reportingYears: readonly ReportingYear[]): string | null {
  const payload = document.payload;
  if (!payload) return null;
  return reportingPeriodForDocument({
    direction: payload.direction, taxPointDate: payload.taxPointDate,
    claimedReportingPeriod: document.claimedReportingPeriod ?? null,
  }, reportingYears) ?? (/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(payload.taxPointDate ?? "")
    ? reportingPeriodForDate(`${payload.taxPointDate!.slice(0, 7)}-01`, reportingYears) : null);
}

/**
 * Supported Czech VAT regimes at 21% and 12%, in the assigned Reporting Period.
 * Unsupported data stays visible as exclusions, never silently treated as zero.
 * Statutory mapping and the whole-Document threshold: docs/vat-rules.md.
 */
export function computeVatReport(
  company: CompanyDetails,
  period: string,
  documents: ReportDocument[],
  reportingYears: readonly ReportingYear[] = [{
    year: Number(period.slice(0, 4)),
    frequency: period.includes("-Q") ? "quarterly" : "monthly",
    firstMonth: 1,
  }],
): ComputedVatReport {
  const vatReturn: VatReturnLine[] = VAT_RETURN_LINES.map(
    (line) => ({ line, netAmount: "0.00", vatAmount: "0.00", documentIds: [] }),
  );
  const controlStatement: ControlStatementEntry[] = [];
  const excludedDocuments: ComputedVatReport["excludedDocuments"] = [];
  for (const document of documents) {
    const payload = document.payload ? omitZeroRateBreakdownRows(document.payload) : null;
    const assignedPeriod = reportingPeriodForReportDocument({ ...document, payload }, reportingYears);
    if (
      !payload ||
      assignedPeriod !== period
    ) continue;
    const reason = vatReportDocumentExclusion({ ...document, payload });
    if (reason) {
      excludedDocuments.push({ documentId: document.id, reason });
      continue;
    }
    // exclusion() refused every incomplete row through validateExtractionPayload.
    const p = czkPayload(payload as CompleteExtractionPayload);
    const reportingRates = (payload.partialClaim ? reportingClaimRates(payload)! : p.rateBreakdown)
      .filter(rate => !isZeroRateBreakdownLine(rate));
    if (!reportingRates.length) continue;
    const counterparty = p.direction === "incoming" ? p.supplier : p.customer;
    const vatId = counterparty.vatId;
    const domestic = p.proposedVatRegime === "domestic";
    const section = deriveDocumentVatMapping(p).controlStatementSection!;
    const individualDomestic = domestic && (section === "A.4" || section === "B.2");
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
    for (const rate of reportingRates) {
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
    controlStatement: controlStatement.map((entry) => ({ ...entry, rateBreakdown: entry.rateBreakdown.filter((line) => !isZeroRateBreakdownLine(line)) })),
    excludedDocuments,
    totals: {
      outputVat: amount(output),
      inputVat: amount(input),
      payable: amount(output > input ? output - input : BigInt(0)),
      excessDeduction: amount(input > output ? input - output : BigInt(0)),
    },
  };
}
