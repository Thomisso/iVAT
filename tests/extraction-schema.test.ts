import { describe, expect, it } from "vitest";
import { EXTRACTION_SCHEMA } from "@/ai/structured-output";

const { properties } = EXTRACTION_SCHEMA;
const matches = (schema: { pattern: string }, value: string) => new RegExp(schema.pattern).test(value);

// Strict structured output enforces these patterns, so a provider cannot
// answer in a format the Extraction payload validation would refuse.
describe("Extraction schema formats", () => {
  it.each([
    ["country", properties.supplier.properties.country, ["CZ", "DE"], ["Czech Republic", "CZE", "cz"]],
    ["currency", properties.currency, ["CZK", "EUR"], ["Kč", "czk", "CZKK"]],
    ["date", properties.taxPointDate, ["2026-10-30"], ["30.10.2026", "2026-10-30T00:00:00Z"]],
    ["amount", properties.totals.properties.grossAmount, ["1210.00", "-5.50", "0.00"], ["1 210,00", "1210", "1210.5"]],
    ["rate breakdown amount", properties.rateBreakdown.items.properties.vatAmount, ["210.00"], ["210,00"]],
    ["reverse charge code", properties.reverseChargeCode, ["1", "21"], ["§92a", "1234"]],
  ])("constrains the %s format", (_name, schema, accepted, refused) => {
    for (const value of accepted) expect(matches(schema, value), value).toBe(true);
    for (const value of refused) expect(matches(schema, value), value).toBe(false);
  });
});
