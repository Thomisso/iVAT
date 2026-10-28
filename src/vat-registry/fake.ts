import type {
  VatPayerRegistry,
  VatPayerRegistryCheck,
} from "@/application/vat-registry";

/** A deterministic registry for tests and local development. */
export function fakeVatPayerRegistry(
  check: VatPayerRegistryCheck = {
    outcome: "checked",
    unreliable: false,
    publishedAccounts: ["123456789/0100"],
  },
): VatPayerRegistry {
  return { check: async () => check };
}
