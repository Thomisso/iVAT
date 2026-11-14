import type { AiUsage } from "@/application/ai-provider";

/** Operator-supplied, explicitly verified tariff. No built-in live price claims. */
export type EvaluationTariff = { provider: string; model: string; inputUsdPerMillion: string; outputUsdPerMillion: string;
  source: string; verifiedAt: string; verified: true };
export type EvaluationPriceEstimate = { usd: string; basis: EvaluationTariff };
const decimal = (value: unknown): value is string => typeof value === "string" && /^\d{1,12}(\.\d{1,6})?$/.test(value);
const pricingReference = (value: unknown) => {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password; }
  catch { return false; }
};
const millionths = (value: string) => { const [whole, fraction = ""] = value.split("."); return BigInt(whole) * BigInt(1000000) + BigInt(fraction.padEnd(6, "0")); };
export const priceUnits = (value: string) => BigInt(value.replace(".", ""));
export const priceAmount = (value: bigint) => `${value / BigInt(1000000000000)}.${String(value % BigInt(1000000000000)).padStart(12, "0")}`;

export function parseEvaluationTariffs(value: unknown): EvaluationTariff[] {
  if (!Array.isArray(value)) throw new Error("evaluation_tariff_invalid");
  const seen = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || typeof entry.provider !== "string" || !entry.provider.trim()
      || typeof entry.model !== "string" || !entry.model.trim() || !decimal(entry.inputUsdPerMillion) || !decimal(entry.outputUsdPerMillion)
      || entry.verified !== true || !pricingReference(entry.source)
      || typeof entry.verifiedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.verifiedAt)
      || !Number.isFinite(Date.parse(entry.verifiedAt)) || new Date(entry.verifiedAt).toISOString().slice(0, 10) !== entry.verifiedAt
      || entry.verifiedAt > new Date().toISOString().slice(0, 10)) throw new Error("evaluation_tariff_invalid");
    const key = JSON.stringify([entry.provider, entry.model]);
    if (seen.has(key)) throw new Error("evaluation_tariff_duplicate");
    seen.add(key);
    return { provider: entry.provider, model: entry.model, inputUsdPerMillion: entry.inputUsdPerMillion,
      outputUsdPerMillion: entry.outputUsdPerMillion, source: entry.source, verifiedAt: entry.verifiedAt, verified: true };
  });
}

export function estimateEvaluationPrice(tariffs: EvaluationTariff[], provider: string, model: string | null, usage: AiUsage | null): EvaluationPriceEstimate | null {
  const basis = tariffs.find(tariff => tariff.provider === provider && tariff.model === model);
  if (!basis || !usage) return null;
  return { usd: priceAmount(BigInt(usage.inputTokens) * millionths(basis.inputUsdPerMillion)
    + BigInt(usage.outputTokens) * millionths(basis.outputUsdPerMillion)), basis };
}

export function estimateGeneratedPlan(tariffs: EvaluationTariff[], models: { provider: string; model: string | null }[], reservedTokens: number) {
  const basis = models.map(selected => tariffs.find(tariff => tariff.provider === selected.provider && tariff.model === selected.model));
  if (basis.some(tariff => !tariff)) return null;
  const verified = basis as EvaluationTariff[];
  const maximumRate = verified.reduce((maximum, tariff) => {
    const rate = millionths(tariff.outputUsdPerMillion);
    return rate > maximum ? rate : maximum;
  }, BigInt(0));
  return { usd: priceAmount(BigInt(reservedTokens) * maximumRate), scope: "generated_tokens_only" as const, basis: verified };
}
