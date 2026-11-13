import type { ExtractionPayload, RateBreakdownLine } from "./extraction-payload";
import { claimBasisKey } from "./partial-claim";
import { validatedDocumentCzkConversion } from "./exchange-rates";
import { halers, amount, assessedVat } from "./money";

/** Exact independent reduction in minor units, half away from zero. */
function reduce(value: string, percentage: number): string {
  const minor = halers(value) * BigInt(percentage);
  return amount((minor + BigInt(50)) / BigInt(100));
}

/** Original-currency actual-use amounts; foreign claims require the saved Document conversion. */
export function proportionalDeductionRates(payload: ExtractionPayload): RateBreakdownLine[] | null {
  const choice = payload.proportionalDeduction;
  if (!choice || payload.partialClaim || choice.origin !== "user" || !choice.confirmed
    || !choice.operatingExpenseConfirmed || !choice.actualUseConfirmed
    || !Number.isInteger(choice.percentage) || choice.percentage! < 1 || choice.percentage! > 99
    || payload.direction !== "incoming" || payload.proposedVatRegime !== "domestic" || !/^[A-Z]{3}$/.test(payload.currency ?? "")
    || (payload.currency !== "CZK" && !validatedDocumentCzkConversion(payload))
    || !["invoice", "receipt", "simplified_tax_document"].includes(payload.documentType ?? "")
    || !payload.rateBreakdown.length
    || Object.keys(choice).some(key => !["percentage", "confirmed", "operatingExpenseConfirmed", "actualUseConfirmed", "origin", "basis"].includes(key))) return null;
  try {
    if (choice.basis && claimBasisKey(choice.basis) !== claimBasisKey(payload)) return null;
    let net = BigInt(0), vat = BigInt(0);
    const seen = new Set<number>();
    const rates: RateBreakdownLine[] = [];
    for (const line of payload.rateBreakdown) {
      if ((line.rate !== 21 && line.rate !== 12) || seen.has(line.rate)
        || !line.netAmount || !line.vatAmount || !/^\d+\.\d{2}$/.test(line.netAmount) || !/^\d+\.\d{2}$/.test(line.vatAmount)) return null;
      const difference = halers(line.vatAmount) - halers(assessedVat(line.netAmount, line.rate));
      if (difference < BigInt(-2) || difference > BigInt(2)) return null;
      seen.add(line.rate);
      net += halers(line.netAmount); vat += halers(line.vatAmount);
      rates.push({ rate: line.rate, netAmount: reduce(line.netAmount, choice.percentage!), vatAmount: reduce(line.vatAmount, choice.percentage!) });
    }
    for (const [original, total] of [[payload.totals.netAmount, net], [payload.totals.vatAmount, vat]] as const) {
      if (!original || !/^\d+\.\d{2}$/.test(original)) return null;
      const difference = halers(original) - total;
      if (difference < BigInt(-2) || difference > BigInt(2)) return null;
    }
    return rates;
  } catch { return null; }
}

/** An Extraction discrepancy stays separate; never present it as unclaimed expenditure. */
export function proportionalUnclaimedPortion(payload: ExtractionPayload) {
  const claimed = proportionalDeductionRates(payload);
  if (!claimed || !payload.totals.grossAmount || !/^\d+\.\d{2}$/.test(payload.totals.grossAmount)) return null;
  const discrepancy = halers(payload.totals.netAmount!) + halers(payload.totals.vatAmount!) - halers(payload.totals.grossAmount);
  if (discrepancy < BigInt(-2) || discrepancy > BigInt(2)) return null;
  const rateBreakdown = payload.rateBreakdown.map(line => {
    const selected = claimed.find(rate => rate.rate === line.rate)!;
    return { rate: line.rate!, netAmount: amount(halers(line.netAmount!) - halers(selected.netAmount)), vatAmount: amount(halers(line.vatAmount!) - halers(selected.vatAmount)) };
  });
  const net = rateBreakdown.reduce((sum, line) => sum + halers(line.netAmount), BigInt(0));
  const vat = rateBreakdown.reduce((sum, line) => sum + halers(line.vatAmount), BigInt(0));
  return { rateBreakdown, netAmount: amount(net), vatAmount: amount(vat), grossAmount: amount(net + vat) };
}

/** Shared review/list totals use the same per-rate rounding as reports. */
export function proportionalDeductionSummary(payload: ExtractionPayload) {
  const rates = proportionalDeductionRates(payload);
  if (!rates) return null;
  const net = rates.reduce((sum, line) => sum + halers(line.netAmount), BigInt(0));
  const vat = rates.reduce((sum, line) => sum + halers(line.vatAmount), BigInt(0));
  return { percentage: payload.proportionalDeduction!.percentage!, rateBreakdown: rates,
    netAmount: amount(net), vatAmount: amount(vat), grossAmount: amount(net + vat), unclaimed: proportionalUnclaimedPortion(payload) };
}
