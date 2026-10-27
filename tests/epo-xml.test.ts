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
  signatoryFirstName: "Jana",
  signatoryLastName: "Nováková",
  signatoryCapacity: "jednatelka",
};
const company = {
  name: "Test & spol. s.r.o.",
  ico: "27082440",
  vatId: "CZ27082440",
  street: "Na Příkopě 1",
  city: "Praha",
  postalCode: "110 00",
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
    const report = computeVatReport(company, "2026-10", []);
    expect(
      await createEpoXml(report, format, {
        taxOffice: "451",
        preparedOn: "2026-10-27",
        personType: "F",
        firstName: "Jan",
        lastName: "Novák",
        email: "",
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
it("preserves XML-special characters in document numbers without creating attributes", async () => {
  const report = domesticReport();
  report.controlStatement[0].documentNumber = 'INV-"<&';
  const result = await createEpoXml(report, "dphkh1", details);
  expect(result.ok && result.value).toContain(
    'c_evid_dd="INV-&quot;&lt;&amp;"',
  );
});
