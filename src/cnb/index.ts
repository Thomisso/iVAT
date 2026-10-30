import { cnbExchangeRates } from "./rates";
import { fakeExchangeRates } from "./fake";

/** Explicit local/test selection; ordinary operation keeps the ČNB adapter. */
export function configuredExchangeRates() {
  const provider = process.env.EXCHANGE_RATE_PROVIDER ?? "cnb";
  if (provider === "fake") return fakeExchangeRates();
  if (provider === "cnb") return cnbExchangeRates();
  throw new Error(`Unknown EXCHANGE_RATE_PROVIDER ${JSON.stringify(provider)}. See .env.example.`);
}
