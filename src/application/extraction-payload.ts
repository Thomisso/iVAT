// The structured data an Extraction reads out of one Document: the payload of
// an Extraction Version. Documented in docs/extraction-payload.md; change both
// together, and bump `schemaVersion` when a change is not backwards compatible.
//
// Every field the Document does not show is null. Amounts are decimal strings
// with a dot and two decimals ("1210.00"), so no value passes through a float;
// Credit Notes carry negative amounts. Dates are ISO dates ("2026-10-27").
// Receipt Date and the claimed Reporting Period belong to the Document, not here.

export type DocumentType = "invoice" | "credit_note" | "debit_note" | "receipt" | "simplified_tax_document" | "other";

export type Direction = "incoming" | "outgoing";

/** The VAT treatments iVAT supports; anything else is `other` (Manual Classification Required). */
export type VatRegime =
  | "domestic"
  | "domestic_reverse_charge"
  | "eu_acquisition_of_goods"
  | "eu_received_service"
  | "other";

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
