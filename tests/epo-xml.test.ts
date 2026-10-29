import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createEpoXml, type ExportDetails } from "@/application/epo-xml";
import { computeVatReport, type ReportDocument } from "@/application/vat-rules";
import { SAMPLE_EXTRACTION } from "@/ai/fake";

export const details: ExportDetails = {
  taxOffice: "451",
  preparedOn: "2026-10-27",
  personType: "P",
  email: "qa@example.test",
  phone: "",
  signatoryFirstName: "Jana",
  signatoryLastName: "Nováková",
  signatoryCapacity: "jednatelka",
};
const company = {
  name: "Test & spol. s.r.o.",
  firstName: null,
  lastName: null,
  ico: "27082440",
  vatId: "CZ27082440",
  streetName: "Na Příkopě",
  houseNumber: "1",
  orientationNumber: null,
  city: "Praha",
  postalCode: "110 00",
  personType: "legal" as const,
};
const rows = [
  ["outgoing", 21, "10000.49", "2100.10", "12100.59"],
  ["outgoing", 12, "2000.50", "240.06", "2240.56"],
  ["incoming", 12, "20000.50", "2400.06", "22400.56"],
  ["incoming", 21, "1000.49", "210.10", "1210.59"],
] as const;
function domesticReport() {
  return computeVatReport(
    { ...company },
    "2026-10",
    rows.map(
      (
        [direction, rate, netAmount, vatAmount, grossAmount],
        i,
      ): ReportDocument => ({
        id: `doc-${i}`,
        extractionVersionId: `version-${i}`,
        status: "approved",
        payload: {
          ...SAMPLE_EXTRACTION,
          direction,
          customer: SAMPLE_EXTRACTION.supplier,
          documentNumber: `INV-${i + 1}`,
          rateBreakdown: [{ rate, netAmount, vatAmount }],
          totals: { netAmount, vatAmount, grossAmount },
        },
      }),
    ),
  );
}
function regimesReport() {
  const cases = [
    {
      proposedVatRegime: "domestic_reverse_charge",
      direction: "outgoing",
      rate: 21,
      netAmount: "1000.00",
      supplierVatId: "CZ27082440",
      supplierCountry: "CZ",
      customerVatId: "CZ45274649",
      customerCountry: "CZ",
      reverseChargeCode: "4",
    },
    {
      proposedVatRegime: "domestic_reverse_charge",
      direction: "incoming",
      rate: 12,
      netAmount: "500.00",
      supplierVatId: "CZ45274649",
      supplierCountry: "CZ",
      customerVatId: "CZ27082440",
      customerCountry: "CZ",
      reverseChargeCode: "4",
    },
    {
      proposedVatRegime: "eu_acquisition_of_goods",
      direction: "incoming",
      rate: 21,
      netAmount: "200.00",
      supplierVatId: "DE123456789",
      supplierCountry: "DE",
      customerVatId: "CZ27082440",
      customerCountry: "CZ",
      reverseChargeCode: null,
    },
    {
      proposedVatRegime: "eu_received_service",
      direction: "incoming",
      rate: 12,
      netAmount: "300.00",
      supplierVatId: "SK2021234567",
      supplierCountry: "SK",
      customerVatId: "CZ27082440",
      customerCountry: "CZ",
      reverseChargeCode: null,
    },
  ] as const;
  return computeVatReport(
    company,
    "2026-10",
    cases.map((entry, index): ReportDocument => ({
      id: `regime-${index + 1}`,
      extractionVersionId: `regime-version-${index + 1}`,
      status: "approved",
      payload: {
        ...SAMPLE_EXTRACTION,
        proposedVatRegime: entry.proposedVatRegime,
        direction: entry.direction,
        documentNumber: `RC-${index + 1}`,
        reverseChargeCode: entry.reverseChargeCode,
        supplier: {
          ...SAMPLE_EXTRACTION.supplier,
          vatId: entry.supplierVatId,
          country: entry.supplierCountry,
        },
        customer: {
          ...SAMPLE_EXTRACTION.customer,
          vatId: entry.customerVatId,
          country: entry.customerCountry,
        },
        rateBreakdown: [
          { rate: entry.rate, netAmount: entry.netAmount, vatAmount: "0.00" },
        ],
        totals: {
          netAmount: entry.netAmount,
          vatAmount: "0.00",
          grossAmount: entry.netAmount,
        },
      },
    })),
  );
}
it("exports the saved domestic VAT Return, with rounded lines, reconciled totals and the Company header", async () => {
  const result = await createEpoXml(domesticReport(), "dphdp3", details);
  expect(result).toEqual({
    ok: true,
    value: fs.readFileSync(
      path.join(__dirname, "fixtures/epo/domestic-dphdp3.xml"),
      "utf8",
    ),
  });
});
it("exports individual and aggregate Control Statement sections with unrounded amounts and reconciliation", async () => {
  const result = await createEpoXml(domesticReport(), "dphkh1", details);
  expect(result).toEqual({
    ok: true,
    value: fs.readFileSync(
      path.join(__dirname, "fixtures/epo/domestic-dphkh1.xml"),
      "utf8",
    ),
  });
});
it.each(["dphdp3", "dphkh1"] as const)(
  "exports reverse-charge and EU regimes as XSD-valid golden %s XML",
  async (format) => {
    const result = await createEpoXml(regimesReport(), format, details);
    expect(result).toEqual({
      ok: true,
      value: fs.readFileSync(
        path.join(__dirname, `fixtures/epo/regimes-${format}.xml`),
        "utf8",
      ),
    });
  },
);
it.each(["dphdp3", "dphkh1"] as const)(
  "blocks %s whose Company header violates the official XSD",
  async (format) => {
    const report = domesticReport();
    report.company.name = "x".repeat(256);
    expect(await createEpoXml(report, format, details)).toEqual({
      ok: false,
      error: "xml_invalid",
    });
  },
);
it.each(["dphdp3", "dphkh1"] as const)(
  "requires the filing details that the Company does not yet store for %s",
  async (format) => {
    expect(
      await createEpoXml(domesticReport(), format, {
        ...details,
        taxOffice: "",
      }),
    ).toEqual({ ok: false, error: "invalid_export_details" });
  },
);
it.each(["dphdp3", "dphkh1"] as const)(
  "exports an empty %s for a natural person without inventing a legal Company name",
  async (format) => {
    const report = computeVatReport({
      ...company,
      name: "Jan Novák",
      firstName: "Jan",
      lastName: "Novák",
      personType: "natural",
    }, "2026-10", []);
    expect(
      await createEpoXml(report, format, {
        taxOffice: "451",
        preparedOn: "2026-10-27",
        personType: "F",
        email: "",
        phone: "",
      }),
    ).toEqual({
      ok: true,
      value: fs.readFileSync(
        path.join(__dirname, `fixtures/epo/empty-${format}.xml`),
        "utf8",
      ),
    });
  },
);
it.each(["dphdp3", "dphkh1"] as const)(
  "exports quarterly Reporting Period metadata for %s",
  async (format) => {
    const report = computeVatReport(company, "2026-Q4", [], [
      { frequency: "quarterly", effectiveFrom: "2026-01-01" },
    ]);

    const result = await createEpoXml(report, format, details);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('rok="2026" ctvrt="4"');
    expect(result.value).not.toContain('mesic="');
  },
);
it("preserves XML-special characters in document numbers without creating attributes", async () => {
  const report = domesticReport();
  report.controlStatement[0].documentNumber = 'INV-"<&';
  const result = await createEpoXml(report, "dphkh1", details);
  expect(result.ok && result.value).toContain(
    'c_evid_dd="INV-&quot;&lt;&amp;"',
  );
});
