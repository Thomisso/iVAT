import { describe, expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import {
  applyCnbConversion,
  type ExchangeRateProvider,
} from "@/application/exchange-rates";

const rates: ExchangeRateProvider = {
  async rateFor(date, currency) {
    return {
      currency,
      requestedDate: date,
      rateDate: "2026-10-02",
      unit: currency === "JPY" ? 100 : 1,
      rate: currency === "JPY" ? "13.835" : "24.340",
      source: "CNB",
    };
  },
};

describe("ČNB currency conversion", () => {
  it("preserves EUR originals and adds exact CZK amounts and provenance", async () => {
    const original = {
      ...SAMPLE_EXTRACTION,
      currency: "EUR",
      taxPointDate: "2026-10-03",
      rateBreakdown: [
        { rate: 21, netAmount: "10.00", vatAmount: "2.10" },
      ],
      totals: {
        netAmount: "10.00",
        vatAmount: "2.10",
        grossAmount: "12.10",
      },
    };

    const converted = await applyCnbConversion(original, rates);

    expect(converted.payload).toEqual({
      ...original,
      czkConversion: {
        originalCurrency: "EUR",
        rate: "24.340",
        unit: 1,
        rateDate: "2026-10-02",
        source: "CNB",
        rateBreakdown: [
          { rate: 21, netAmount: "243.40", vatAmount: "51.11" },
        ],
        totals: {
          netAmount: "243.40",
          vatAmount: "51.11",
          grossAmount: "294.51",
        },
      },
    });
    expect(converted.findings).toEqual([]);
  });

  it("honors rates quoted for 100 units and rounds to halers", async () => {
    const converted = await applyCnbConversion(
      {
        ...SAMPLE_EXTRACTION,
        currency: "JPY",
        rateBreakdown: [
          { rate: 21, netAmount: "1000.00", vatAmount: "210.00" },
        ],
        totals: {
          netAmount: "1000.00",
          vatAmount: "210.00",
          grossAmount: "1210.00",
        },
      },
      rates,
    );

    expect(converted.payload.czkConversion?.totals).toEqual({
      netAmount: "138.35",
      vatAmount: "29.05",
      grossAmount: "167.40",
    });
  });

  it("removes a stale conversion for CZK and marks a missing foreign rate", async () => {
    const stale = {
      ...SAMPLE_EXTRACTION,
      czkConversion: {
        originalCurrency: "EUR",
        rate: "24.340",
        unit: 1,
        rateDate: "2026-10-01",
        source: "CNB" as const,
        rateBreakdown: [],
        totals: { netAmount: "0.00", vatAmount: "0.00", grossAmount: "0.00" },
      },
    };
    expect((await applyCnbConversion(stale, rates)).payload).toEqual(
      SAMPLE_EXTRACTION,
    );
    const unavailable: ExchangeRateProvider = { rateFor: async () => null };
    const result = await applyCnbConversion(
      { ...SAMPLE_EXTRACTION, currency: "USD" },
      unavailable,
    );
    expect(result.payload.czkConversion).toBeUndefined();
    expect(result.findings).toEqual([
      {
        field: "currency",
        severity: "warning",
        code: "currency_conversion_not_performed",
      },
    ]);
  });
});
