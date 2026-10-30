import type { ValidationFinding } from "./document-validation";
import { isZeroRateBreakdownLine, type CzkConversion, type ExtractionPayload, type RateBreakdownLine } from "./extraction-payload";

export type CnbRate = {
  currency: string;
  requestedDate: string;
  rateDate: string;
  unit: number;
  rate: string;
  source: "CNB";
};

/** External daily-rate seam; application tests inject a deterministic fake. */
export interface ExchangeRateProvider {
  rateFor(date: string, currency: string): Promise<CnbRate | null>;
}

function withoutConversion(payload: ExtractionPayload): ExtractionPayload {
  const original = { ...payload };
  delete original.czkConversion;
  return original;
}

function scaledDecimal(value: string): { value: bigint; scale: bigint } | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const decimals = match[2] ?? "";
  return { value: BigInt(`${match[1]}${decimals}`), scale: BigInt(10) ** BigInt(decimals.length) };
}

/** Converts a two-decimal amount with integer arithmetic and rounds to halers. */
function convertedAmount(value: string | null, rate: CnbRate): string | null {
  if (value === null) return null;
  const amount = /^(-?)(\d+)\.(\d{2})$/.exec(value);
  const quote = scaledDecimal(rate.rate);
  if (!amount || !quote || !Number.isInteger(rate.unit) || rate.unit <= 0) return null;
  const originalHalers = BigInt(`${amount[2]}${amount[3]}`);
  const denominator = quote.scale * BigInt(rate.unit);
  const absolute = (originalHalers * quote.value + denominator / BigInt(2)) / denominator;
  const converted = amount[1] ? -absolute : absolute;
  const magnitude = converted < BigInt(0) ? -converted : converted;
  return `${converted < BigInt(0) ? "-" : ""}${magnitude / BigInt(100)}.${String(magnitude % BigInt(100)).padStart(2, "0")}`;
}

function conversion(payload: ExtractionPayload, rate: CnbRate): CzkConversion | null {
  const rateBreakdown = payload.rateBreakdown.map((line): RateBreakdownLine | null => {
    const netAmount = convertedAmount(line.netAmount, rate);
    const vatAmount = convertedAmount(line.vatAmount, rate);
    return netAmount === null || vatAmount === null ? null : { ...line, netAmount, vatAmount };
  });
  const totals = {
    netAmount: convertedAmount(payload.totals.netAmount, rate),
    vatAmount: convertedAmount(payload.totals.vatAmount, rate),
    grossAmount: convertedAmount(payload.totals.grossAmount, rate),
  };
  if (rateBreakdown.some((line) => line === null)) return null;
  return {
    originalCurrency: payload.currency!, rate: rate.rate, unit: rate.unit,
    rateDate: rate.rateDate, source: rate.source,
    rateBreakdown: (rateBreakdown as RateBreakdownLine[]).filter((line) => !isZeroRateBreakdownLine(line)), totals,
  };
}

const notPerformed: ValidationFinding = {
  field: "currency", severity: "warning", code: "currency_conversion_not_performed",
};

/** Replaces any stale conversion and applies the fixing for current currency/DUZP. */
export async function applyCnbConversion(
  candidate: ExtractionPayload,
  rates: ExchangeRateProvider,
): Promise<{ payload: ExtractionPayload; findings: ValidationFinding[] }> {
  const payload = withoutConversion(candidate);
  if (!payload.currency || payload.currency === "CZK") return { payload, findings: [] };
  if (!payload.taxPointDate) return { payload, findings: [notPerformed] };
  const rate = await rates.rateFor(payload.taxPointDate, payload.currency);
  const converted = rate && conversion(payload, rate);
  return converted
    ? { payload: { ...payload, czkConversion: converted }, findings: [] }
    : { payload, findings: [notPerformed] };
}
