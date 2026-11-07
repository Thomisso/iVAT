import type { ClaimBasis, ExtractionPayload, RateBreakdownLine } from "./extraction-payload";

function halers(value: string): bigint { return BigInt(value.replace(".", "")); }
function amount(value: bigint): string {
  const absolute = value < BigInt(0) ? -value : value;
  return `${value < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}
function assessedVat(net: string, rate: number): string {
  return amount((halers(net) * BigInt(rate) + BigInt(50)) / BigInt(100));
}

/** The full financial inputs a human confirms, independent of directory/evidence metadata. */
export function claimBasis(payload: ClaimBasis): ClaimBasis {
  const { documentType, direction, currency, proposedVatRegime, taxPointDate, rateBreakdown, totals } = payload;
  return { documentType, direction, currency, proposedVatRegime, taxPointDate, rateBreakdown, totals };
}
export function claimBasisKey(payload: ClaimBasis): string {
  return JSON.stringify([payload.documentType, payload.direction, payload.currency, payload.proposedVatRegime,
    payload.taxPointDate, payload.rateBreakdown.map(r => [r.rate, r.netAmount, r.vatAmount]),
    payload.totals.netAmount, payload.totals.vatAmount, payload.totals.grossAmount]);
}

/** Validates the human amounts separately from the full Document's evidence. */
export function partialClaimRates(payload: ExtractionPayload): RateBreakdownLine[] | null {
  const claim = payload.partialClaim;
  if (payload.direction !== "incoming" || payload.proposedVatRegime !== "domestic"
    || payload.currency !== "CZK" || payload.rateBreakdown.length !== 1
    || payload.documentType === "credit_note") return null;
  if (!claim || claim.confirmed !== true || !Array.isArray(claim.rateBreakdown) || claim.rateBreakdown.length !== 1) return null;
  if (claim.basis) {
    try { if (claimBasisKey(claim.basis) !== claimBasisKey(payload)) return null; }
    catch { return null; }
  }
  const selected = claim.rateBreakdown[0];
  if (!selected || typeof selected !== "object") return null;
  const original = payload.rateBreakdown.find((line) => line.rate === selected.rate);
  if (!original || (selected.rate !== 21 && selected.rate !== 12) || typeof selected.netAmount !== "string" || typeof selected.vatAmount !== "string"
    || !/^-?\d+\.\d{2}$/.test(selected.netAmount) || !/^-?\d+\.\d{2}$/.test(selected.vatAmount)
    || !original.netAmount || !original.vatAmount
    || !payload.totals.netAmount || !payload.totals.vatAmount
    || [original.netAmount, original.vatAmount, payload.totals.netAmount, payload.totals.vatAmount].some(value => !/^-?\d+\.\d{2}$/.test(value))) return null;
  const net = halers(selected.netAmount);
  const vat = halers(selected.vatAmount);
  if (net <= BigInt(0) || vat < BigInt(0)
    || net > halers(original.netAmount) || vat > halers(original.vatAmount)) return null;
  const differences = [
    vat - halers(assessedVat(selected.netAmount, selected.rate)),
    halers(original.vatAmount) - halers(assessedVat(original.netAmount, selected.rate)),
    halers(payload.totals.netAmount) - halers(original.netAmount),
    halers(payload.totals.vatAmount) - halers(original.vatAmount),
  ];
  // Preserve the existing two-haler tolerance; gross-total mismatch is advisory.
  if (differences.some((difference) => (difference < BigInt(0) ? -difference : difference) > BigInt(2))) return null;
  return [{ rate: selected.rate, netAmount: selected.netAmount, vatAmount: selected.vatAmount }];
}

/** No numeric remainder exists before activation or while source arithmetic is inconsistent. */
export function unclaimedPortion(payload: ExtractionPayload) {
  const selected = partialClaimRates(payload);
  const { netAmount, vatAmount, grossAmount } = payload.totals;
  if (!selected || !netAmount || !vatAmount || !grossAmount || !/^-?\d+\.\d{2}$/.test(grossAmount)) return null;
  const difference = halers(netAmount) + halers(vatAmount) - halers(grossAmount);
  if ((difference < BigInt(0) ? -difference : difference) > BigInt(2)) return null;
  const net = halers(payload.rateBreakdown[0].netAmount!) - halers(selected[0].netAmount);
  const vat = halers(payload.rateBreakdown[0].vatAmount!) - halers(selected[0].vatAmount);
  return { netAmount: amount(net), vatAmount: amount(vat), grossAmount: amount(net + vat) };
}
