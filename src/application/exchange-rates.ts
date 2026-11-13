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

/** Stored fixing associated with this Document; callers validate usable amounts/rates. */
export function documentCzkConversion(
  payload: Pick<ExtractionPayload, "currency" | "taxPointDate" | "czkConversion">,
): CzkConversion | null {
  const conversion = payload.czkConversion;
  if (!conversion || conversion.originalCurrency !== payload.currency || !payload.taxPointDate
    || conversion.rateDate > payload.taxPointDate) return null;
  return conversion;
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
export function convertedAmount(value: string | null, rate: Pick<CnbRate, "rate" | "unit">): string | null {
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

/** A saved full-Document fixing is usable only while every saved amount still corresponds. */
export function validatedDocumentCzkConversion(payload: ExtractionPayload): CzkConversion | null {
  try {
    const saved = documentCzkConversion(payload);
    const quote = saved && typeof saved.rate === "string" ? scaledDecimal(saved.rate) : null;
    const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith("0000")
      && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!saved || !quote || quote.value <= BigInt(0) || saved.source !== "CNB"
      || !/^[A-Z]{3}$/.test(payload.currency ?? "") || payload.currency === "CZK"
      || !Number.isSafeInteger(saved.unit) || saved.unit <= 0
      || !validDate(saved.rateDate) || !payload.taxPointDate || !validDate(payload.taxPointDate)
      || !saved.totals || !Array.isArray(saved.rateBreakdown)) return null;
    for (const key of ["netAmount", "vatAmount", "grossAmount"] as const) {
      if (typeof payload.totals[key] !== "string" || typeof saved.totals[key] !== "string"
        || convertedAmount(payload.totals[key], saved) !== saved.totals[key]) return null;
    }
    const original = payload.rateBreakdown.filter(line => !isZeroRateBreakdownLine(line));
    if (original.length !== saved.rateBreakdown.length || new Set(original.map(line => line.rate)).size !== original.length) return null;
    for (const line of original) {
      const converted = saved.rateBreakdown.filter(row => row && row.rate === line.rate);
      if (converted.length !== 1 || typeof line.netAmount !== "string" || typeof line.vatAmount !== "string"
        || convertedAmount(line.netAmount, saved) !== converted[0].netAmount
        || convertedAmount(line.vatAmount, saved) !== converted[0].vatAmount) return null;
    }
    return saved;
  } catch { return null; }
}

function conversion(payload: ExtractionPayload, rate: CnbRate): CzkConversion | null {
  const rateBreakdown = payload.rateBreakdown.map((line): RateBreakdownLine | null => {
    const netAmount = convertedAmount(line.netAmount, rate);
    const vatAmount = convertedAmount(line.vatAmount, rate);
    return netAmount === null || vatAmount === null || line.rate === null ? null : { rate: line.rate, netAmount, vatAmount };
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
