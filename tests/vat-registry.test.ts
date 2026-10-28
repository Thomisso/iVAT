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
