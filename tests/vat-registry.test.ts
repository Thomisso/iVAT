import { describe, expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import {
  vatRegistryFindings,
  type VatPayerRegistry,
  type VatPayerRegistryCheck,
} from "@/application/vat-registry";

function registry(result: VatPayerRegistryCheck): VatPayerRegistry {
  return { check: async () => result };
}

describe("VAT payer registry findings", () => {
  it("recognizes a zero-valued prefix as the same Payment Account as a missing prefix", async () => {
    expect(await vatRegistryFindings(registry({
      outcome: "checked", unreliable: false, publishedAccounts: ["2000145399/0800"],
    }), { ...SAMPLE_EXTRACTION, payment: { ...SAMPLE_EXTRACTION.payment, bankAccount: "000000-2000145399/0800" } })).toEqual([]);
  });

  // Public Czech IBAN worked example already used by the ADIS adapter tests.
  it.each([
    ["19-2000145399/0800", null, "CZ6508000000192000145399"],
    [null, "cz65 0800 0000 1920 0014 5399", "19-2000145399/0800"],
    ["000019-02000145399 / 0800", "CZ6508000000192000145399", "19-2000145399/0800"],
    ["000000-2000145399/0800", "CZ7908000000002000145399", "2000145399/0800"],
    [null, "CZ7908000000002000145399", "000000-2000145399/0800"],
  ])("checks domestic %s and IBAN %s as one Payment Account", async (bankAccount, iban, published) => {
    const payload = { ...SAMPLE_EXTRACTION, payment: { ...SAMPLE_EXTRACTION.payment, bankAccount, iban } };
    const original = structuredClone(payload);
    expect(await vatRegistryFindings(registry({
      outcome: "checked", unreliable: false, publishedAccounts: [published],
    }), payload)).toEqual([]);
    expect(payload).toEqual(original);
  });

  it.each([
    { label: "the IBAN", publishedAccounts: ["19-2000145399/0800"] },
    { label: "the domestic account", publishedAccounts: ["2000145399/0800"] },
    { label: "neither representation", publishedAccounts: [] },
  ])("leaves contradictory representations unresolved when the registry publishes $label", async ({ publishedAccounts }) => {
    expect(await vatRegistryFindings(registry({
      outcome: "checked", unreliable: true, publishedAccounts,
    }), { ...SAMPLE_EXTRACTION, payment: { ...SAMPLE_EXTRACTION.payment,
      bankAccount: "2000145399/0800", iban: "CZ6508000000192000145399",
    } })).toEqual([
      { field: "supplier.vatId", severity: "warning", code: "unreliable_vat_payer" },
      { field: "payment.bankAccount", severity: "warning", code: "inconsistent_payment_account" },
    ]);
  });

  it.each([
    ["gateway-order-123", null],
    [null, "CZ0008000000192000145399"],
    ["19-2000145399/0800", "not-an-iban"],
    ["123456789012/0800", null],
  ])("does not label unrecognized domestic %s / IBAN %s as unpublished", async (bankAccount, iban) => {
    expect(await vatRegistryFindings(registry({
      outcome: "checked", unreliable: false, publishedAccounts: ["unrecognized-registry-value"],
    }), { ...SAMPLE_EXTRACTION, payment: { ...SAMPLE_EXTRACTION.payment, bankAccount, iban } })).toEqual([
      { field: iban ? "payment.iban" : "payment.bankAccount", severity: "warning", code: "unrecognized_payment_account" },
    ]);
  });

  it("checks the outgoing supplier's receiving account and identifies it as the Company's own account", async () => {
    const outgoing = { ...SAMPLE_EXTRACTION, direction: "outgoing" as const,
      supplier: { ...SAMPLE_EXTRACTION.supplier, vatId: "CZ25596641" },
      customer: { ...SAMPLE_EXTRACTION.customer, vatId: "CZ27082440" },
    };
    const ownRegistry: VatPayerRegistry = { check: async (vatId) => ({
      outcome: "checked", unreliable: false, publishedAccounts: vatId === "CZ25596641" ? [] : ["123456789/0100"],
    }) };
    expect(await vatRegistryFindings(ownRegistry, outgoing)).toEqual([
      { field: "payment.bankAccount", severity: "warning", code: "unpublished_own_bank_account" },
    ]);
  });

  it.each([
    { result: { outcome: "unavailable" } as VatPayerRegistryCheck, code: "own_vat_registry_check_not_performed", field: "supplier.vatId" },
    { result: { outcome: "not_found" } as VatPayerRegistryCheck, code: "own_bank_account_not_verified", field: "payment.bankAccount" },
    { result: { outcome: "checked", unreliable: true, publishedAccounts: ["123456789/0100"] } as VatPayerRegistryCheck, code: "unreliable_own_vat_payer", field: "supplier.vatId" },
  ])("identifies the outgoing Company in $code", async ({ result, code, field }) => {
    expect(await vatRegistryFindings(registry(result), { ...SAMPLE_EXTRACTION, direction: "outgoing" })).toEqual([
      { field, severity: "warning", code },
    ]);
  });

  it("retains the inconsistency advisory alongside registry unavailability", async () => {
    expect(await vatRegistryFindings(registry({ outcome: "unavailable" }), {
      ...SAMPLE_EXTRACTION, payment: { ...SAMPLE_EXTRACTION.payment, bankAccount: "2000145399/0800", iban: "CZ6508000000192000145399" },
    })).toEqual([
      { field: "supplier.vatId", severity: "warning", code: "vat_registry_check_not_performed" },
      { field: "payment.bankAccount", severity: "warning", code: "inconsistent_payment_account" },
    ]);
  });

  it("warns about an unreliable supplier and an unpublished payment account", async () => {
    const findings = await vatRegistryFindings(
      registry({
        outcome: "checked",
        unreliable: true,
        publishedAccounts: ["19-2000145399/0800"],
      }),
      SAMPLE_EXTRACTION,
    );

    expect(findings).toEqual([
      {
        field: "supplier.vatId",
        severity: "warning",
        code: "unreliable_vat_payer",
      },
      {
        field: "payment.bankAccount",
        severity: "warning",
        code: "unpublished_bank_account",
      },
    ]);
  });

  it("recognizes published standard accounts despite insignificant zeroes", async () => {
    const payload = {
      ...SAMPLE_EXTRACTION,
      payment: {
        ...SAMPLE_EXTRACTION.payment,
        bankAccount: "000019-02000145399/0800",
      },
    };

    expect(
      await vatRegistryFindings(
        registry({
          outcome: "checked",
          unreliable: false,
          publishedAccounts: ["19-2000145399/0800"],
        }),
        payload,
      ),
    ).toEqual([]);
  });

  it("recognizes a published IBAN without depending on spaces or case", async () => {
    const payload = {
      ...SAMPLE_EXTRACTION,
      payment: {
        ...SAMPLE_EXTRACTION.payment,
        bankAccount: null,
        iban: "cz65 0800 0000 1920 0014 5399",
      },
    };

    expect(
      await vatRegistryFindings(
        registry({
          outcome: "checked",
          unreliable: false,
          publishedAccounts: ["CZ6508000000192000145399"],
        }),
        payload,
      ),
    ).toEqual([]);
  });

  it.each([
    ["an unavailable result", registry({ outcome: "unavailable" })],
    [
      "an adapter failure",
      { check: async () => Promise.reject(new Error("network failed")) },
    ],
  ])("marks the check as not performed for %s", async (_case, unavailable) => {
    expect(await vatRegistryFindings(unavailable, SAMPLE_EXTRACTION)).toEqual([
      {
        field: "supplier.vatId",
        severity: "warning",
        code: "vat_registry_check_not_performed",
      },
    ]);
  });

  it("does not query ADIS when there is no Czech supplier VAT ID", async () => {
    let calls = 0;
    const fake: VatPayerRegistry = {
      async check() {
        calls++;
        return { outcome: "unavailable" };
      },
    };
    const payload = {
      ...SAMPLE_EXTRACTION,
      supplier: { ...SAMPLE_EXTRACTION.supplier, vatId: "DE123456789" },
    };

    expect(await vatRegistryFindings(fake, payload)).toEqual([]);
    expect(calls).toBe(0);
  });
});
