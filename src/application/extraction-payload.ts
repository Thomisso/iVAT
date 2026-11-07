import { remapSourceField, type SourceEvidence, type SourceLocation } from "./source-locations";
import type { ValidationFinding } from "./document-validation";

// The structured data an Extraction reads out of one Document: the payload of
// an Extraction Version. Documented in docs/extraction-payload.md; change both
// together, and bump `schemaVersion` when a change is not backwards compatible.
//
// Every field the Document does not show is null. Amounts are decimal strings
// with a dot and two decimals ("1210.00"), so no value passes through a float;
// Credit Notes carry negative amounts. Dates are ISO dates ("2026-10-27").
// The Deferred Claim belongs to the Document, not here.

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

/** A human can preserve a partially entered row before completing review. */
export type DraftRateBreakdownLine = {
  rate: number | null;
  netAmount: string | null;
  vatAmount: string | null;
};

export type CzkConversion = {
  originalCurrency: string;
  /** CZK quoted for `unit` units of the original currency. */
  rate: string;
  unit: number;
  /** Actual fixing date returned by ČNB (may precede a weekend/holiday DUZP). */
  rateDate: string;
  source: "CNB";
  rateBreakdown: RateBreakdownLine[];
  totals: { netAmount: string | null; vatAmount: string | null; grossAmount: string | null };
};

/** A human selection of separate supplies; full source amounts remain unchanged. */
export type ClaimBasis = Pick<ExtractionPayload, "documentType" | "direction" | "currency" | "proposedVatRegime" | "taxPointDate" | "rateBreakdown" | "totals">;

export type PartialClaim = {
  basis?: ClaimBasis;
  confirmed: boolean;
  /** An explicit human decision to keep this Document recorded without a deduction. */
  zeroConfirmed?: boolean;
  rateBreakdown: DraftRateBreakdownLine[];
};

export type ExtractionPayload = {
  /** Human accounting confirmation or the accepted same-period rule; never AI authority. */
  claimEligibility?: {
    period: string;
    origin: "user" | "same_period";
    confirmed: boolean;
    basis?: { documentType: DocumentType | null; direction: Direction | null; proposedVatRegime: VatRegime | null;
      taxPointDate: string | null; issueDate: string | null; sourceFileId: string | null; importDate: string | null };
  };
  schemaVersion: 1 | 2;
  documentType: DocumentType | null;
  documentNumber: string | null;
  issueDate: string | null;
  taxPointDate: string | null;
  dueDate: string | null;
  direction: Direction | null;
  /** Existing directory identity and its then-current details; never replaces Party fields. */
  counterpartyLink?: { id: string; recorded?: Party } | null;
  supplier: Party;
  customer: Party;
  /** ISO 4217, e.g. "CZK". */
  currency: string | null;
  rateBreakdown: DraftRateBreakdownLine[];
  totals: { netAmount: string | null; vatAmount: string | null; grossAmount: string | null };
  payment: { variableSymbol: string | null; bankAccount: string | null; iban: string | null };
  proposedVatRegime: VatRegime | null;
  /** Official Control Statement subject code for domestic reverse charge. */
  reverseChargeCode: string | null;
  /** For a Credit Note: the number of the Document it corrects. */
  originalDocumentNumber: string | null;
  /** Absent on legacy/full claims. AI must never create or confirm this choice. */
  partialClaim?: PartialClaim | null;
  /** Derived CZK values; the printed currency and amounts above stay unchanged. */
  czkConversion?: CzkConversion;
  /**
   * How sure the provider is of a field, from 0 to 1, keyed by the field's path
   * ("documentNumber", "supplier.vatId", "rateBreakdown.0.vatAmount"). Optional,
   * and only for fields the provider reports on.
   */
  confidence?: Record<string, number>;
  /** Unbound references returned by a provider; only server-bound evidence is usable in review. */
  sourceLocations?: SourceLocation[];
  sourceEvidence?: SourceEvidence;
  /** Submitted base row identities; validated and removed at immutable Version insertion. */
  sourceRateRows?: (number | null)[];
};

/** Nothing is inferred for a new manual Document, including its DUZP and Direction. */
export function emptyDocumentPayload(): ExtractionPayload {
  const party = (): Party => ({ name: null, ico: null, vatId: null, street: null, city: null, postalCode: null, country: null });
  return {
    schemaVersion: 1, documentType: null, documentNumber: null,
    issueDate: null, taxPointDate: null, dueDate: null, direction: null,
    supplier: party(), customer: party(), currency: null, rateBreakdown: [],
    totals: { netAmount: null, vatAmount: null, grossAmount: null },
    payment: { variableSymbol: null, bankAccount: null, iban: null },
    proposedVatRegime: null, reverseChargeCode: null, originalDocumentNumber: null,
  };
}

export type ExtractionPayloadError =
  | "invalid_choice"
  | "invalid_amount"
  | "invalid_credit_note_amount"
  | "invalid_rate"
  | "invalid_date"
  | "invalid_currency"
  | "invalid_country"
  | "invalid_reverse_charge_code";

export type ManualDocumentPayloadError = ExtractionPayloadError | "tax_point_date_required";

/** Manual Versions must always retain a real DUZP, including unfinished drafts. */
export function validateManualDocumentPayload(payload: ExtractionPayload): ManualDocumentPayloadError | null {
  if (!payload.taxPointDate) return "tax_point_date_required";
  return validateExtractionPayload(payload, { draft: true });
}

/** Whether a value is null or one of the choices. */
const isChoice = (choices: readonly string[], value: string | null) => value === null || choices.includes(value);

const AMOUNT = /^-?\d+\.\d{2}$/;

/** Amount syntax failures, addressed to the caller's original Rate Breakdown rows. */
function invalidAmountFields(payload: ExtractionPayload): string[] {
  const fields: [string, string | null][] = [
    ...payload.rateBreakdown.flatMap((line, index): [string, string | null][] => {
      const row = payload.sourceRateRows?.[index] ?? index;
      return [[`rateBreakdown.${row}.netAmount`, line.netAmount], [`rateBreakdown.${row}.vatAmount`, line.vatAmount]];
    }),
    ["totals.netAmount", payload.totals.netAmount],
    ["totals.vatAmount", payload.totals.vatAmount],
    ["totals.grossAmount", payload.totals.grossAmount],
  ];
  return fields.filter(([, value]) => value !== null && !AMOUNT.test(value)).map(([field]) => field);
}

/** Whether a value is an ISO date of a day that exists. */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** An amount as typed ("1 210,5") in the payload's form ("1210.50"); left as typed when it is no number. */
function normalizeAmount(amount: string | null): string | null {
  if (amount === null || !amount.trim()) return null;
  const typed = amount.replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d{1,2})?$/.test(typed)) return typed;
  const [whole, decimals = ""] = typed.split(".");
  return `${whole}.${decimals.padEnd(2, "0")}`;
}

const normalizeCode = (code: string | null) => code?.replace(/\s/g, "").toUpperCase() ?? null;

/** Only two actual zero amounts make an empty row; missing/invalid amounts stay reviewable. */
export function isZeroRateBreakdownLine(line: Pick<DraftRateBreakdownLine, "netAmount" | "vatAmount">): boolean {
  return line.netAmount !== null && line.vatAmount !== null
    && /^-?0+\.00$/.test(line.netAmount) && /^-?0+\.00$/.test(line.vatAmount);
}

/** Prepares a new payload without changing the source or misattributing provider confidence. */
export function omitZeroRateBreakdownRows(payload: ExtractionPayload, { omitEmpty = false }: { omitEmpty?: boolean } = {}): ExtractionPayload {
  const retained = payload.rateBreakdown.flatMap((line, index) =>
    isZeroRateBreakdownLine(line) || (omitEmpty && (line.rate === null || Number.isNaN(line.rate)) && !line.netAmount?.trim() && !line.vatAmount?.trim())
      ? [] : [{ line, index }]);
  const newIndices = new Map(retained.map((entry, index) => [entry.index, index]));
  const confidence = payload.confidence
    ? Object.fromEntries(Object.entries(payload.confidence).flatMap(([field, value]) => {
      const mapped = remapSourceField(field, newIndices);
      return mapped === null ? [] : [[mapped, value]];
    }))
    : undefined;
  return {
    ...payload,
    rateBreakdown: retained.map((entry) => entry.line),
    ...(confidence ? { confidence } : {}),
    ...(payload.sourceRateRows ? { sourceRateRows: retained.map(({ index }) => payload.sourceRateRows?.[index] ?? null) } : {}),
    ...(payload.sourceLocations ? { sourceLocations: payload.sourceLocations.flatMap((location) => {
      const fieldPath = remapSourceField(location.fieldPath, newIndices);
      return fieldPath === null ? [] : [{ ...location, fieldPath }];
    }) } : {}),
    ...(payload.sourceEvidence ? { sourceEvidence: { ...payload.sourceEvidence,
      fields: Object.fromEntries(Object.entries(payload.sourceEvidence.fields).flatMap(([field, evidence]) => {
        const mapped = remapSourceField(field, newIndices);
        return mapped === null ? [] : [[mapped, evidence]];
      })),
    } } : {}),
    ...(payload.czkConversion ? {
      czkConversion: {
        ...payload.czkConversion,
        rateBreakdown: payload.czkConversion.rateBreakdown.filter((line) => !isZeroRateBreakdownLine(line)),
      },
    } : {}),
  };
}

/**
 * A payload as a person typed it, in the payload's conventions: amounts with a
 * dot and two decimals, codes and VAT IDs in capitals without spaces. Rate
 * Breakdown lines left entirely empty or with two zero amounts are dropped.
 */
export function normalizeExtractionPayload(payload: ExtractionPayload): ExtractionPayload {
  const amount = (value: string | null) => (value === null ? null : normalizeAmount(value));
  const party = (p: Party): Party => ({ ...p, vatId: normalizeCode(p.vatId), country: normalizeCode(p.country) });
  const normalized = omitZeroRateBreakdownRows({
    ...payload,
    currency: normalizeCode(payload.currency),
    reverseChargeCode: payload.reverseChargeCode?.trim() || null,
    supplier: party(payload.supplier),
    customer: party(payload.customer),
    rateBreakdown: payload.rateBreakdown
      .map((line) => ({ ...line, netAmount: normalizeAmount(line.netAmount), vatAmount: normalizeAmount(line.vatAmount) })),
    ...(payload.partialClaim ? { partialClaim: {
      ...payload.partialClaim,
      rateBreakdown: payload.partialClaim.rateBreakdown.map(line => ({ ...line,
        netAmount: normalizeAmount(line.netAmount), vatAmount: normalizeAmount(line.vatAmount),
      })),
    } } : {}),
    totals: {
      netAmount: amount(payload.totals.netAmount),
      vatAmount: amount(payload.totals.vatAmount),
      grossAmount: amount(payload.totals.grossAmount),
    },
  }, { omitEmpty: true });
  return normalized.rateBreakdown.some((line) => line.rate === null || line.netAmount === null || line.vatAmount === null)
    ? { ...normalized, schemaVersion: 2 }
    : normalized;
}

type PayloadIssue = { field: string | null; code: ExtractionPayloadError };

/** Ordered parser issues retain the existing refusal precedence and submitted row identities. */
function extractionPayloadIssues(payload: ExtractionPayload, { draft = false }: { draft?: boolean } = {}): PayloadIssue[] {
  const issues: PayloadIssue[] = [];
  const add = (field: string | null, code: ExtractionPayloadError) => issues.push({ field, code });
  // Schema metadata has no editable form field; do not invent a focus target.
  if (![1, 2].includes(payload.schemaVersion)) add(null, "invalid_choice");
  if (!isChoice(DOCUMENT_TYPES, payload.documentType)) add("documentType", "invalid_choice");
  if (!isChoice(DIRECTIONS, payload.direction)) add("direction", "invalid_choice");
  if (!isChoice(VAT_REGIMES, payload.proposedVatRegime)) add("proposedVatRegime", "invalid_choice");
  for (const field of invalidAmountFields(payload)) add(field, "invalid_amount");
  if (!draft || payload.schemaVersion === 1) {
    payload.rateBreakdown.forEach((line, index) => {
      const row = payload.sourceRateRows?.[index] ?? index;
      if (line.netAmount === null) add(`rateBreakdown.${row}.netAmount`, "invalid_amount");
      if (line.vatAmount === null) add(`rateBreakdown.${row}.vatAmount`, "invalid_amount");
    });
  }
  const amounts = [...payload.rateBreakdown.flatMap(line => [line.netAmount, line.vatAmount]),
    payload.totals.netAmount, payload.totals.vatAmount, payload.totals.grossAmount];
  if (!draft && payload.documentType === "credit_note"
    && (amounts.some(value => value !== null && Number(value) > 0)
      || !amounts.some(value => value !== null && Number(value) < 0))) add(null, "invalid_credit_note_amount");
  payload.rateBreakdown.forEach((line, index) => {
    if (line.rate === null ? !draft || payload.schemaVersion === 1 : !Number.isFinite(line.rate) || line.rate < 0 || line.rate > 100) {
      add(`rateBreakdown.${payload.sourceRateRows?.[index] ?? index}.rate`, "invalid_rate");
    }
  });
  for (const field of ["issueDate", "taxPointDate", "dueDate"] as const) {
    const value = payload[field];
    if (value !== null && !isIsoDate(value)) add(field, "invalid_date");
  }
  if (payload.currency !== null && !/^[A-Z]{3}$/.test(payload.currency)) add("currency", "invalid_currency");
  const reverseChargeCode = payload.reverseChargeCode ?? null;
  if (reverseChargeCode !== null && !/^\d{1,3}$/.test(reverseChargeCode)) add("reverseChargeCode", "invalid_reverse_charge_code");
  for (const party of ["supplier", "customer"] as const) {
    const country = payload[party].country;
    if (country !== null && !/^[A-Z]{2}$/.test(country)) add(`${party}.country`, "invalid_country");
  }
  return issues;
}

/** The first convention a payload breaks, preserving draft and Credit Note semantics. */
export function validateExtractionPayload(payload: ExtractionPayload, options: { draft?: boolean } = {}): ExtractionPayloadError | null {
  return extractionPayloadIssues(payload, options)[0]?.code ?? null;
}

/** Every editable parser error for a manual submission; nullable unfinished draft fields stay allowed. */
export function manualDocumentPayloadFindings(payload: ExtractionPayload): ValidationFinding[] {
  const issues = extractionPayloadIssues(payload, { draft: true });
  return [
    ...(!payload.taxPointDate ? [{ field: "taxPointDate", severity: "error" as const, code: "tax_point_date_required" }] : []),
    ...issues.flatMap(issue => issue.field === null || issue.field === "taxPointDate" && !payload.taxPointDate ? [] : [{ field: issue.field, severity: "error" as const, code: issue.code }]),
  ];
}
