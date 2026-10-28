import type { CnbRate, ExchangeRateProvider } from "@/application/exchange-rates";

const ENDPOINT = "https://api.cnb.cz/cnbapi/exrates/daily";
type DailyResponse = { rates?: unknown };
type DailyRate = { validFor: string; amount: number; currencyCode: string; rate: number };

function isDailyRate(value: unknown): value is DailyRate {
  if (!value || typeof value !== "object") return false;
  const rate = value as Partial<DailyRate>;
  return typeof rate.validFor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rate.validFor)
    && typeof rate.amount === "number" && Number.isInteger(rate.amount) && rate.amount > 0
    && typeof rate.currencyCode === "string" && /^[A-Z]{3}$/.test(rate.currencyCode)
    && typeof rate.rate === "number" && Number.isFinite(rate.rate) && rate.rate > 0;
}

/** Official ČNB JSON adapter, caching the whole daily fixing per requested date. */
export function cnbExchangeRates(fetcher: typeof fetch = fetch): ExchangeRateProvider {
  const cache = new Map<string, Promise<Map<string, DailyRate> | null>>();
  const daily = (date: string) => {
    let pending = cache.get(date);
    if (!pending) {
      pending = (async () => {
        try {
          const response = await fetcher(`${ENDPOINT}?date=${encodeURIComponent(date)}&lang=EN`, {
            headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000),
          });
          if (!response.ok) return null;
          const payload = (await response.json()) as DailyResponse;
          if (!Array.isArray(payload.rates) || !payload.rates.every(isDailyRate)) return null;
          return new Map(payload.rates.map((rate) => [rate.currencyCode, rate]));
        } catch { return null; }
      })();
      cache.set(date, pending);
    }
    return pending;
  };
  return {
    async rateFor(date, currency): Promise<CnbRate | null> {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Z]{3}$/.test(currency)) return null;
      const rate = (await daily(date))?.get(currency);
      return rate ? {
        currency, requestedDate: date, rateDate: rate.validFor, unit: rate.amount,
        rate: String(rate.rate), source: "CNB",
      } : null;
    },
  };
}
