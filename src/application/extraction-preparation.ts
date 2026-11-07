import type { Result } from "./client";
import { CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA, validateDocument, type ValidationFinding } from "./document-validation";
import { applyCnbConversion, type ExchangeRateProvider } from "./exchange-rates";
import { normalizeExtractionPayload, omitZeroRateBreakdownRows, validateManualDocumentPayload, type ExtractionPayload, type ManualDocumentPayloadError } from "./extraction-payload";
import { vatRegistryFindings, type VatPayerRegistry } from "./vat-registry";

/** Manual draft refusals precede the correction's RLS lookup and any external work. */
export function prepareManualExtractionPayload(candidate: ExtractionPayload): Result<ExtractionPayload, ManualDocumentPayloadError> {
  // Keep the caller's pre-normalization row identity when this preparation
  // removes zero/empty rows. Already compacted rows without a map remain
  // ambiguous and the database safely omits their references.
  const payload = normalizeExtractionPayload(candidate.sourceRateRows ? candidate : {
    ...candidate, sourceRateRows: candidate.rateBreakdown.map((_, index) => index),
  });
  if (!candidate.sourceRateRows && payload.rateBreakdown.length === candidate.rateBreakdown.length) delete payload.sourceRateRows;
  const invalid = validateManualDocumentPayload(payload);
  if (invalid) return { ok: false, error: invalid };
  delete payload.confidence;
  return { ok: true, value: payload };
}

/**
 * Prepares one new Version's amounts and findings without writing it. Direction
 * detection belongs to the AI caller. Findings finish separately so that caller
 * can retain its independent usage accounting after ČNB and before the registry.
 */
export async function prepareExtractionVersion(
  candidate: ExtractionPayload,
  exchangeRates: ExchangeRateProvider,
  vatRegistry: VatPayerRegistry,
): Promise<{ payload: ExtractionPayload; findings: () => Promise<ValidationFinding[]> }> {
  const conversion = await applyCnbConversion(omitZeroRateBreakdownRows(candidate), exchangeRates);
  const payload = conversion.payload;
  return {
    payload,
    async findings() {
      return [
        ...validateDocument(payload, CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA),
        ...(await vatRegistryFindings(vatRegistry, payload)),
        ...conversion.findings,
      ];
    },
  };
}
