// The structured data an Extraction reads out of one Document: the payload of
// an Extraction Version. Documented in docs/extraction-payload.md; change both
// together, and bump `schemaVersion` when a change is not backwards compatible.
//
// Every field the Document does not show is null. Amounts are decimal strings
// with a dot and two decimals ("1210.00"), so no value passes through a float;
// Credit Notes carry negative amounts. Dates are ISO dates ("2026-10-27").
// Receipt Date and the claimed Reporting Period belong to the Document, not here.

export const DOCUMENT_TYPES = ["invoice", "credit_note", "debit_note", "receipt", "simplified_tax_document", "other"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DIRECTIONS = ["incoming", "outgoing"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** The VAT treatments iVAT supports; anything else is `other` (Manual Classification Required). */
export const VAT_REGIMES = [
  "domestic",
  "domestic_reverse_charge",
  "eu_acquisition_of_goods",
  "eu_received_service",
  "other",
] as const;
export type VatRegime = (typeof VAT_REGIMES)[number];

export type Party = {
  name: string | null;
  ico: string | null;
  vatId: string | null;
  street: string | null;
  city: string | null;
  postalCode: string | null;
  /** ISO 3166-1 alpha-2, e.g. "CZ". */
  country: string | null;
};

/** One line of the Rate Breakdown: the net and VAT amounts at one VAT rate. */
export type RateBreakdownLine = {
  /** Percent, e.g. 21 or 12; 0 for supplies without VAT. */
  rate: number;
  netAmount: string;
  vatAmount: string;
};

export type ExtractionPayload = {
  schemaVersion: 1;
  documentType: DocumentType | null;
  documentNumber: string | null;
  issueDate: string | null;
  taxPointDate: string | null;
  dueDate: string | null;
  direction: Direction | null;
  supplier: Party;
  customer: Party;
  /** ISO 4217, e.g. "CZK". */
  currency: string | null;
  rateBreakdown: RateBreakdownLine[];
  totals: { netAmount: string | null; vatAmount: string | null; grossAmount: string | null };
  payment: { variableSymbol: string | null; bankAccount: string | null; iban: string | null };
  proposedVatRegime: VatRegime | null;
  /** For a Credit Note: the number of the Document it corrects. */
  originalDocumentNumber: string | null;
  /**
   * How sure the provider is of a field, from 0 to 1, keyed by the field's path
   * ("documentNumber", "supplier.vatId", "rateBreakdown.0.vatAmount"). Optional,
   * and only for fields the provider reports on.
   */
  confidence?: Record<string, number>;
};

export type ExtractionPayloadError =
  | "invalid_choice"
  | "invalid_amount"
  | "invalid_rate"
  | "invalid_date"
  | "invalid_currency"
  | "invalid_country";

/** Whether a value is null or one of the choices. */
const isChoice = (choices: readonly string[], value: string | null) => value === null || choices.includes(value);

const AMOUNT = /^-?\d+\.\d{2}$/;

/** Whether a value is an ISO date of a day that exists. */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** An amount as typed ("1 210,5") in the payload's form ("1210.50"); left as typed when it is no number. */
function normalizeAmount(amount: string): string {
  const typed = amount.replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d{1,2})?$/.test(typed)) return typed;
  const [whole, decimals = ""] = typed.split(".");
  return `${whole}.${decimals.padEnd(2, "0")}`;
}

const normalizeCode = (code: string | null) => code?.replace(/\s/g, "").toUpperCase() ?? null;

/**
 * A payload as a person typed it, in the payload's conventions: amounts with a
 * dot and two decimals, codes and VAT IDs in capitals without spaces. Rate
 * Breakdown lines left entirely empty are dropped.
 */
export function normalizeExtractionPayload(payload: ExtractionPayload): ExtractionPayload {
  const amount = (value: string | null) => (value === null ? null : normalizeAmount(value));
  const party = (p: Party): Party => ({ ...p, vatId: normalizeCode(p.vatId), country: normalizeCode(p.country) });
  return {
    ...payload,
    currency: normalizeCode(payload.currency),
    supplier: party(payload.supplier),
    customer: party(payload.customer),
    rateBreakdown: payload.rateBreakdown
      .filter((line) => !(Number.isNaN(line.rate) && !line.netAmount.trim() && !line.vatAmount.trim()))
      .map((line) => ({ ...line, netAmount: normalizeAmount(line.netAmount), vatAmount: normalizeAmount(line.vatAmount) })),
    totals: {
      netAmount: amount(payload.totals.netAmount),
      vatAmount: amount(payload.totals.vatAmount),
      grossAmount: amount(payload.totals.grossAmount),
    },
  };
}

/** The first convention a payload breaks, or null. Null fields are always allowed. */
export function validateExtractionPayload(payload: ExtractionPayload): ExtractionPayloadError | null {
  if (
    !isChoice(DOCUMENT_TYPES, payload.documentType) ||
    !isChoice(DIRECTIONS, payload.direction) ||
    !isChoice(VAT_REGIMES, payload.proposedVatRegime)
  ) {
    return "invalid_choice";
  }
  const amounts = [
    ...payload.rateBreakdown.flatMap((line) => [line.netAmount, line.vatAmount]),
    payload.totals.netAmount,
    payload.totals.vatAmount,
    payload.totals.grossAmount,
  ];
  if (amounts.some((amount) => amount !== null && !AMOUNT.test(amount))) return "invalid_amount";
  if (payload.rateBreakdown.some((line) => !Number.isFinite(line.rate) || line.rate < 0 || line.rate > 100)) {
    return "invalid_rate";
  }
  const dates = [payload.issueDate, payload.taxPointDate, payload.dueDate];
  if (dates.some((date) => date !== null && !isIsoDate(date))) return "invalid_date";
  if (payload.currency !== null && !/^[A-Z]{3}$/.test(payload.currency)) return "invalid_currency";
  const countries = [payload.supplier.country, payload.customer.country];
  if (countries.some((country) => country !== null && !/^[A-Z]{2}$/.test(country))) return "invalid_country";
  return null;
}
