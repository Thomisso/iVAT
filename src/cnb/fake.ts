import type { ExchangeRateProvider } from "@/application/exchange-rates";

/** Deterministic ČNB seam for application tests and local development. */
export function fakeExchangeRates(rate = "25.00", unit = 1): ExchangeRateProvider {
  return {
    async rateFor(date, currency) {
      return { currency, requestedDate: date, rateDate: date, unit, rate, source: "CNB" };
    },
  };
}
