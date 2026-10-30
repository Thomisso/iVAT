import { adisVatPayerRegistry } from "./adis";
import { fakeVatPayerRegistry } from "./fake";

/** Explicit local/test selection; ordinary operation keeps the ADIS adapter. */
export function configuredVatPayerRegistry() {
  const provider = process.env.VAT_REGISTRY_PROVIDER ?? "adis";
  if (provider === "fake") return fakeVatPayerRegistry();
  if (provider === "adis") return adisVatPayerRegistry();
  throw new Error(`Unknown VAT_REGISTRY_PROVIDER ${JSON.stringify(provider)}. See .env.example.`);
}
