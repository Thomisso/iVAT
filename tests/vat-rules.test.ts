import { describe, expect, it } from "vitest";
import { computeVatReport, type ReportDocument } from "@/application/vat-rules";
import { SAMPLE_EXTRACTION } from "@/ai/fake";

const company = {
  name: "Test s.r.o.",
  ico: "27082440",
  vatId: "CZ27082440",
  street: "Praha 1",
  city: "Praha",
  postalCode: "110 00",
  personType: "legal" as const,
};
const period = "2026-10";
function document(
  overrides: Partial<typeof SAMPLE_EXTRACTION> = {},
): ReportDocument {
  return {
    id: "doc-1",
    extractionVersionId: "version-1",
    status: "approved",
    payload: { ...SAMPLE_EXTRACTION, ...overrides },
  };
}

describe("domestic Rules Engine", () => {
  it.each([
    ["outgoing", 21, "1"],
    ["outgoing", 12, "2"],
    ["incoming", 21, "40"],
    ["incoming", 12, "41"],
  ] as const)(
    "maps %s at %s percent to VAT Return line %s with traceability",
    (direction, rate, line) => {
      const report = computeVatReport(company, period, [
        document({
          direction,
          rateBreakdown: [
            {
              rate,
              netAmount: "1000.00",
              vatAmount: rate === 21 ? "210.00" : "120.00",
            },
          ],
          totals: {
            netAmount: "1000.00",
            vatAmount: rate === 21 ? "210.00" : "120.00",
            grossAmount: rate === 21 ? "1210.00" : "1120.00",
          },
        }),
      ]);
      expect(report.vatReturn.find((entry) => entry.line === line)).toEqual({
        line,
        netAmount: "1000.00",
        vatAmount: rate === 21 ? "210.00" : "120.00",
        documentIds: ["doc-1"],
      });
    },
  );
});

it.each([
  ["outgoing", "10000.00", "A.5"],
  ["outgoing", "10000.01", "A.4"],
  ["incoming", "10000.00", "B.3"],
  ["incoming", "10000.01", "B.2"],
] as const)("puts %s gross %s into %s", (direction, grossAmount, section) => {
  const report = computeVatReport(company, period, [
    document({
      direction,
      customer: SAMPLE_EXTRACTION.supplier,
      totals: { netAmount: "9000.00", vatAmount: "1000.00", grossAmount },
      rateBreakdown: [{ rate: 21, netAmount: "9000.00", vatAmount: "1000.00" }],
    }),
  ]);
  expect(report.controlStatement).toEqual([
    expect.objectContaining({ section, documentIds: ["doc-1"] }),
  ]);
});
it("aggregates small Documents per section and rate with exact decimals and unique contributors", () => {
  const first = document({
    rateBreakdown: [
      { rate: 21, netAmount: "0.10", vatAmount: "0.02" },
      { rate: 12, netAmount: "0.20", vatAmount: "0.02" },
    ],
  });
  const second = {
    ...document({
      rateBreakdown: [{ rate: 21, netAmount: "0.20", vatAmount: "0.04" }],
    }),
    id: "doc-2",
  };
  const report = computeVatReport(company, period, [first, second]);
  expect(report.controlStatement).toEqual([
    expect.objectContaining({
      section: "B.3",
      documentIds: ["doc-1", "doc-2"],
      rateBreakdown: [
        {
          rate: 21,
          netAmount: "0.30",
          vatAmount: "0.06",
          documentIds: ["doc-1", "doc-2"],
        },
        {
          rate: 12,
          netAmount: "0.20",
          vatAmount: "0.02",
          documentIds: ["doc-1"],
        },
      ],
    }),
  ]);
  expect(report.totals).toEqual({
    outputVat: "0.00",
    inputVat: "0.08",
    payable: "0.00",
    excessDeduction: "0.08",
  });
});
it("never counts unapproved, unsupported or incomplete Documents and ignores other periods", () => {
  const report = computeVatReport(company, period, [
    { ...document(), id: "review", status: "needs_review" },
    { ...document({ proposedVatRegime: "other" }), id: "manual" },
    { ...document({ currency: "EUR" }), id: "foreign" },
    { ...document({ direction: null }), id: "incomplete" },
    { ...document({ taxPointDate: "2026-10-99" }), id: "date" },
    { ...document({ taxPointDate: "2026-11-01" }), id: "november" },
  ]);
  expect(report.excludedDocuments).toEqual([
    { documentId: "review", reason: "not_approved" },
    { documentId: "manual", reason: "manual_classification_required" },
    { documentId: "foreign", reason: "currency_conversion_required" },
    { documentId: "incomplete", reason: "incomplete_data" },
    { documentId: "date", reason: "incomplete_data" },
  ]);
  expect(report.vatReturn.every((line) => line.documentIds.length === 0)).toBe(
    true,
  );
});
it("keeps separate high-value Documents, and outgoing supplies without a Czech VAT ID go to A.5", () => {
  const data = {
    direction: "outgoing" as const,
    customer: SAMPLE_EXTRACTION.supplier,
    totals: {
      netAmount: "10000.00",
      vatAmount: "2100.00",
      grossAmount: "12100.00",
    },
  };
  const report = computeVatReport(company, period, [
    document(data),
    { ...document(data), id: "doc-2" },
    {
      ...document({ ...data, customer: { ...data.customer, vatId: null } }),
      id: "consumer",
    },
  ]);
  expect(
    report.controlStatement.map((entry) => [entry.section, entry.documentIds]),
  ).toEqual([
    ["A.4", ["doc-1"]],
    ["A.4", ["doc-2"]],
    ["A.5", ["consumer"]],
  ]);
});
it("uses the absolute whole-Document amount for mixed-rate and negative entries", () => {
  const payload = {
    direction: "outgoing" as const,
    customer: SAMPLE_EXTRACTION.supplier,
    totals: {
      netAmount: "-10000.00",
      vatAmount: "-1650.00",
      grossAmount: "-11650.00",
    },
    rateBreakdown: [
      { rate: 21, netAmount: "-5000.00", vatAmount: "-1050.00" },
      { rate: 12, netAmount: "-5000.00", vatAmount: "-600.00" },
    ],
  };
  const report = computeVatReport(company, period, [document(payload)]);
  expect(report.controlStatement).toEqual([
    expect.objectContaining({
      section: "A.4",
      documentIds: ["doc-1"],
      rateBreakdown: [
        expect.objectContaining({
          rate: 21,
          netAmount: "-5000.00",
          vatAmount: "-1050.00",
        }),
        expect.objectContaining({
          rate: 12,
          netAmount: "-5000.00",
          vatAmount: "-600.00",
        }),
      ],
    }),
  ]);
  expect(report.totals).toEqual({
    outputVat: "-1650.00",
    inputVat: "0.00",
    payable: "0.00",
    excessDeduction: "1650.00",
  });
});

it("returns contributors for summary values from the Rules Engine", () => {
  const report = computeVatReport(company, period, [
    document(),
    { ...document({ direction: "outgoing" }), id: "sale" },
  ]);
  expect(report.totalDocumentIds).toEqual({
    outputVat: ["sale"],
    inputVat: ["doc-1"],
    payable: ["sale", "doc-1"],
    excessDeduction: ["sale", "doc-1"],
  });
});
