import { SAMPLE_EXTRACTION } from "@/ai/fake";
import type { ExtractionPayload } from "@/application/extraction-payload";

/** Wholly synthetic analogue of the confirmed deployed contradiction. */
export const SYNTHETIC_EXCLUDED_PURCHASE: ExtractionPayload = {
  ...SAMPLE_EXTRACTION,
  documentNumber: "SYNTHETIC-ORLEN-REGRESSION",
  taxPointDate: "2026-10-15",
  direction: "incoming",
  proposedVatRegime: "domestic",
  currency: "CZK",
  supplier: { ...SAMPLE_EXTRACTION.supplier, name: "Synthetic fuel supplier", vatId: null, ico: null },
  rateBreakdown: [{ rate: 21, netAmount: "100.00", vatAmount: "21.00" }],
  totals: { netAmount: "100.00", vatAmount: "21.00", grossAmount: "121.00" },
  payment: { bankAccount: null, iban: null, variableSymbol: null },
};
