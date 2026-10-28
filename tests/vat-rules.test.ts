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

describe("reverse charge and EU Rules Engine", () => {
  it.each([
    ["domestic_reverse_charge", "outgoing", 21, ["25"], "A.1"],
    ["domestic_reverse_charge", "outgoing", 12, ["25"], "A.1"],
    ["domestic_reverse_charge", "incoming", 21, ["10", "43"], "B.1"],
    ["domestic_reverse_charge", "incoming", 12, ["11", "44"], "B.1"],
    ["eu_acquisition_of_goods", "incoming", 21, ["3", "43"], "A.2"],
    ["eu_acquisition_of_goods", "incoming", 12, ["4", "44"], "A.2"],
    ["eu_received_service", "incoming", 21, ["5", "43"], "A.2"],
    ["eu_received_service", "incoming", 12, ["6", "44"], "A.2"],
  ] as const)(
    "maps %s %s at %s percent to Return lines %j and Control Statement %s",
    (proposedVatRegime, direction, rate, lines, section) => {
      const vatAmount = rate === 21 ? "210.00" : "120.00";
      const report = computeVatReport(company, period, [
        document({
          proposedVatRegime,
          direction,
          reverseChargeCode:
            proposedVatRegime === "domestic_reverse_charge" ? "4" : null,
          supplier:
            proposedVatRegime.startsWith("eu_")
              ? { ...SAMPLE_EXTRACTION.supplier, vatId: "DE123456789", country: "DE" }
              : SAMPLE_EXTRACTION.supplier,
          customer: SAMPLE_EXTRACTION.supplier,
          rateBreakdown: [{ rate, netAmount: "1000.00", vatAmount: "0.00" }],
          totals: { netAmount: "1000.00", vatAmount: "0.00", grossAmount: "1000.00" },
        }),
      ]);

      for (const line of lines) {
        expect(report.vatReturn.find((entry) => entry.line === line)).toEqual({
          line,
          netAmount: "1000.00",
          vatAmount: line === "25" ? "0.00" : vatAmount,
          documentIds: ["doc-1"],
        });
      }
      expect(report.controlStatement).toEqual([
        expect.objectContaining({
          section,
          reverseChargeCode:
            proposedVatRegime === "domestic_reverse_charge" ? "4" : null,
          documentIds: ["doc-1"],
        }),
      ]);
    },
  );

  it.each(["eu_acquisition_of_goods", "eu_received_service"] as const)(
    "requires manual classification for outgoing %s",
    (proposedVatRegime) => {
      const report = computeVatReport(company, period, [
        document({ proposedVatRegime, direction: "outgoing" }),
      ]);
      expect(report.excludedDocuments).toEqual([
        { documentId: "doc-1", reason: "manual_classification_required" },
      ]);
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

it("uses stored CZK conversion amounts while preserving foreign originals", () => {
  const foreign = document({
    currency: "EUR",
    rateBreakdown: [
      { rate: 21, netAmount: "10.00", vatAmount: "2.10" },
    ],
    totals: {
      netAmount: "10.00",
      vatAmount: "2.10",
      grossAmount: "12.10",
    },
    czkConversion: {
      originalCurrency: "EUR",
      rate: "24.340",
      unit: 1,
      rateDate: "2026-10-01",
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

  const report = computeVatReport(company, period, [foreign]);

  expect(foreign.payload?.totals.grossAmount).toBe("12.10");
  expect(report.vatReturn.find((line) => line.line === "40")).toEqual({
    line: "40",
    netAmount: "243.40",
    vatAmount: "51.11",
    documentIds: ["doc-1"],
  });
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
describe("Credit Notes", () => {
  it.each([
    ["domestic", "outgoing", ["1"], "A.5"],
    ["domestic", "incoming", ["40"], "B.3"],
    ["domestic_reverse_charge", "outgoing", ["25"], "A.1"],
    ["domestic_reverse_charge", "incoming", ["10", "43"], "B.1"],
    ["eu_acquisition_of_goods", "incoming", ["3", "43"], "A.2"],
    ["eu_received_service", "incoming", ["5", "43"], "A.2"],
  ] as const)(
    "subtracts %s %s amounts from Return lines %j and Control Statement %s",
    (proposedVatRegime, direction, lines, section) => {
      const selfAssessed = proposedVatRegime !== "domestic";
      const eu = proposedVatRegime.startsWith("eu_");
      const report = computeVatReport(company, period, [
        document({
          documentType: "credit_note",
          originalDocumentNumber: "ORIGINAL-1",
          proposedVatRegime,
          direction,
          supplier: eu
            ? { ...SAMPLE_EXTRACTION.supplier, vatId: "DE123456789", country: "DE" }
            : SAMPLE_EXTRACTION.supplier,
          customer: SAMPLE_EXTRACTION.supplier,
          reverseChargeCode:
            proposedVatRegime === "domestic_reverse_charge" ? "4" : null,
          rateBreakdown: [
            {
              rate: 21,
              netAmount: "-1000.00",
              vatAmount: selfAssessed ? "0.00" : "-210.00",
            },
          ],
          totals: {
            netAmount: "-1000.00",
            vatAmount: selfAssessed ? "0.00" : "-210.00",
            grossAmount: selfAssessed ? "-1000.00" : "-1210.00",
          },
        }),
      ]);

      for (const line of lines) {
        expect(report.vatReturn.find((entry) => entry.line === line)).toEqual({
          line,
          netAmount: "-1000.00",
          vatAmount: line === "25" ? "0.00" : "-210.00",
          documentIds: ["doc-1"],
        });
      }
      expect(report.controlStatement).toEqual([
        expect.objectContaining({
          section,
          documentIds: ["doc-1"],
          rateBreakdown: [
            expect.objectContaining({
              rate: 21,
              netAmount: "-1000.00",
              vatAmount: section === "A.1" ? "0.00" : "-210.00",
            }),
          ],
        }),
      ]);
    },
  );

  it.each([
    ["outgoing", "-10000.00", "A.5"],
    ["outgoing", "-10000.01", "A.4"],
    ["incoming", "-10000.00", "B.3"],
    ["incoming", "-10000.01", "B.2"],
  ] as const)(
    "uses the absolute Credit Note gross amount for %s %s in %s",
    (direction, grossAmount, section) => {
      const aboveThreshold = grossAmount === "-10000.01";
      const report = computeVatReport(company, period, [
        document({
          documentType: "credit_note",
          originalDocumentNumber: "ORIGINAL-1",
          direction,
          customer: SAMPLE_EXTRACTION.supplier,
          rateBreakdown: [
            { rate: 21, netAmount: "-5000.00", vatAmount: "-1050.00" },
            {
              rate: 12,
              netAmount: "-3526.79",
              vatAmount: aboveThreshold ? "-423.22" : "-423.21",
            },
          ],
          totals: {
            netAmount: "-8526.79",
            vatAmount: aboveThreshold ? "-1473.22" : "-1473.21",
            grossAmount,
          },
        }),
      ]);

      expect(report.controlStatement).toEqual([
        expect.objectContaining({ section, documentIds: ["doc-1"] }),
      ]);
    },
  );

  it("reports a Credit Note in the Reporting Period of its own Tax Point Date", () => {
    const creditNote = document({
      documentType: "credit_note",
      originalDocumentNumber: "ORIGINAL-FROM-SEPTEMBER",
      taxPointDate: "2026-10-15",
      rateBreakdown: [
        { rate: 21, netAmount: "-100.00", vatAmount: "-21.00" },
      ],
      totals: {
        netAmount: "-100.00",
        vatAmount: "-21.00",
        grossAmount: "-121.00",
      },
    });

    expect(
      computeVatReport(company, "2026-09", [creditNote]).vatReturn.every(
        (line) => line.documentIds.length === 0,
      ),
    ).toBe(true);
    expect(
      computeVatReport(company, "2026-10", [creditNote]).vatReturn.find(
        (line) => line.line === "40",
      ),
    ).toEqual({
      line: "40",
      netAmount: "-100.00",
      vatAmount: "-21.00",
      documentIds: ["doc-1"],
    });
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
