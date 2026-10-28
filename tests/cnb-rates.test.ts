import { describe, expect, it, vi } from "vitest";
import { cnbExchangeRates } from "@/cnb/rates";

describe("ČNB exchange-rate adapter", () => {
  it("loads a daily fixing once and caches all currencies by requested date", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        rates: [
          { validFor: "2026-10-02", amount: 1, currencyCode: "EUR", rate: 24.34 },
          { validFor: "2026-10-02", amount: 100, currencyCode: "JPY", rate: 13.835 },
        ],
      }),
    );
    const provider = cnbExchangeRates(fetcher);

    await expect(provider.rateFor("2026-10-03", "EUR")).resolves.toEqual({
      currency: "EUR",
      requestedDate: "2026-10-03",
      rateDate: "2026-10-02",
      unit: 1,
      rate: "24.34",
      source: "CNB",
    });
    await expect(provider.rateFor("2026-10-03", "JPY")).resolves.toEqual(
      expect.objectContaining({ currency: "JPY", unit: 100, rate: "13.835" }),
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://api.cnb.cz/cnbapi/exrates/daily?date=2026-10-03&lang=EN",
    );
  });

  it("returns no rate for transport errors, malformed data or an unknown currency", async () => {
    const failed = cnbExchangeRates(async () => {
      throw new Error("offline");
    });
    const malformed = cnbExchangeRates(async () => Response.json({ rates: [{ nope: true }] }));
    const missing = cnbExchangeRates(async () => Response.json({ rates: [] }));

    await expect(failed.rateFor("2026-10-03", "EUR")).resolves.toBeNull();
    await expect(malformed.rateFor("2026-10-03", "EUR")).resolves.toBeNull();
    await expect(missing.rateFor("2026-10-03", "EUR")).resolves.toBeNull();
  });
});
