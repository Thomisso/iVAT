import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { computeVatReport } from "@/application/vat-rules";
import { createEpoXml, type ExportDetails } from "@/application/epo-xml";
import { createVatReturnPdf } from "@/application/vat-return-pdf";
import { createControlStatementPdf } from "@/application/control-statement-pdf";
import { vatReturnPreviewData } from "@/application/vat-return-preview";
import { controlStatementPreviewData } from "@/application/control-statement-preview";
import { prepareControlStatement } from "@/application/epo-values";

async function fields(bytes: Uint8Array, pageNumber: number, cells: number[][]) {
  const task = getDocument({ data: Uint8Array.from(bytes) });
  try {
    const page = await (await task.promise).getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    return cells.map(([left, top, right, bottom]) => content.items.flatMap((item) => {
      if (!("str" in item)) return [];
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      return x >= left && x < right && y >= top && y <= bottom ? [item.str] : [];
    }).join("").trim());
  } finally {
    await task.destroy();
  }
}

it("keeps a Partial Claim's Return, B.2, summaries and statutory XML/PDF amounts together", async () => {
  const company = {
    name: "Test s.r.o.", firstName: null, lastName: null, ico: "27082440", vatId: "CZ27082440",
    streetName: "Praha", houseNumber: "1", orientationNumber: null, city: "Praha", postalCode: "110 00", personType: "legal" as const,
  };
  const report = computeVatReport(company, "2026-10", [{
    id: "doc-1", extractionVersionId: "version-1", status: "approved",
    payload: {
      ...SAMPLE_EXTRACTION,
      rateBreakdown: [{ rate: 21, netAmount: "12000.00", vatAmount: "2520.00" }],
      totals: { netAmount: "12000.00", vatAmount: "2520.00", grossAmount: "14520.00" },
      partialClaim: {
        confirmed: true,
        rateBreakdown: [{ rate: 21, netAmount: "6000.00", vatAmount: "1260.00" }],
      },
    },
  }]);
  const details: ExportDetails = {
    taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", preparedOn: "2026-10-27",
    personType: "P", email: "qa@example.test", phone: "", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
  };
  const returnXml = await createEpoXml(report, "dphdp3", details);
  const controlXml = await createEpoXml(report, "dphkh1", details);
  if (!returnXml.ok || !controlXml.ok) throw new Error("Statutory XML validation refused the Partial Claim");

  expect(returnXml.value).toContain('pln23="6000" odp_tuz23_nar="1260"');
  expect(controlXml.value).toMatch(/<VetaB2\b[^>]*pomer="N"[^>]*zakl_dane1="6000\.00" dan1="1260\.00"/);
  expect(controlXml.value).not.toContain("<VetaB3");
  expect(controlStatementPreviewData(report)).toMatchObject({
    sections: [{ section: "B.2", totals: { netAmount: "6000.00", vatAmount: "1260.00" } }],
    totals: { netAmount: "6000.00", vatAmount: "1260.00" },
  });
  expect(vatReturnPreviewData(report).totals.inputVat).toBe("1260.00");

  const returnPdf = await createVatReturnPdf(vatReturnPreviewData(report));
  const controlPdf = await createControlStatementPdf({ company, period: "2026-10", details }, prepareControlStatement(report));
  expect(await fields(returnPdf, 2, [[283.46, 479.17, 378.32, 493.34], [378.32, 479.17, 464.82, 493.34]]))
    .toEqual(["6000", "1260"]);
  expect(await fields(controlPdf, 2, [[371, 148, 441, 161], [441, 148, 510, 161], [787, 148, 808, 161]]))
    .toEqual(["6000.00", "1260.00", "N"]);
});

it("records an explicitly confirmed zero selection without a deduction or a zero Control Statement row", async () => {
  const company = {
    name: "Test s.r.o.", firstName: null, lastName: null, ico: "27082440", vatId: "CZ27082440",
    streetName: "Praha", houseNumber: "1", orientationNumber: null, city: "Praha", postalCode: "110 00", personType: "legal" as const,
  };
  const payload = { ...SAMPLE_EXTRACTION,
    partialClaim: { confirmed: true, zeroConfirmed: true, rateBreakdown: [{ rate: 21, netAmount: "0.00", vatAmount: "0.00" }] },
  };
  const report = computeVatReport(company, "2026-10", [{ id: "zero", extractionVersionId: "zero-v1", status: "approved", payload }]);
  expect(report.excludedDocuments).toEqual([]);
  expect(report.vatReturn.every(line => line.netAmount === "0.00" && line.vatAmount === "0.00" && !line.documentIds.length)).toBe(true);
  expect(report.totals).toEqual({ outputVat: "0.00", inputVat: "0.00", payable: "0.00", excessDeduction: "0.00" });
  expect(report.controlStatement).toEqual([]);
  const details: ExportDetails = {
    taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", preparedOn: "2026-10-27",
    personType: "P", email: "qa@example.test", phone: "", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
  };
  const xml = await createEpoXml(report, "dphkh1", details);
  if (!xml.ok) throw new Error("Statutory XML validation refused the zero claim report");
  expect(xml.value).not.toMatch(/<VetaB[123]\b/);
  const pdf = await createControlStatementPdf({ company, period: "2026-10", details }, prepareControlStatement(report));
  expect(await fields(pdf, 2, [[371, 148, 441, 161], [441, 148, 510, 161]])).toEqual(["", ""]);
  const pending = computeVatReport(company, "2026-10", [{ id: "pending-zero", extractionVersionId: "zero-v2", status: "approved",
    payload: { ...payload, partialClaim: { ...payload.partialClaim, confirmed: false } },
  }]);
  expect(pending.excludedDocuments).toEqual([{ documentId: "pending-zero", reason: "incomplete_data" }]);
  expect(pending.controlStatement).toEqual([]);
});

it("uses the full Document's fixing for selected mixed-rate foreign supplies in XML and PDF", async () => {
  const company = {
    name: "Test s.r.o.", firstName: null, lastName: null, ico: "27082440", vatId: "CZ27082440",
    streetName: "Praha", houseNumber: "1", orientationNumber: null, city: "Praha", postalCode: "110 00", personType: "legal" as const,
  };
  const payload = {
    ...SAMPLE_EXTRACTION, currency: "EUR",
    rateBreakdown: [
      { rate: 21, netAmount: "1000.10", vatAmount: "210.02" },
      { rate: 12, netAmount: "1000.20", vatAmount: "120.02" },
    ],
    totals: { netAmount: "2000.30", vatAmount: "330.04", grossAmount: "2330.34" },
    czkConversion: {
      originalCurrency: "EUR", rate: "24.345", unit: 1, rateDate: "2026-10-01", source: "CNB" as const,
      rateBreakdown: [
        { rate: 21, netAmount: "24347.43", vatAmount: "5112.94" },
        { rate: 12, netAmount: "24349.87", vatAmount: "2921.89" },
      ],
      totals: { netAmount: "48697.30", vatAmount: "8034.82", grossAmount: "56732.13" },
    },
    partialClaim: { confirmed: true, rateBreakdown: [
      { rate: 21, netAmount: "333.35", vatAmount: "70.00" },
      { rate: 12, netAmount: "100.05", vatAmount: "12.01" },
    ] },
  };
  const report = computeVatReport(company, "2026-10", [{ id: "foreign", extractionVersionId: "fx-v1", status: "approved", payload }]);
  expect(report.excludedDocuments).toEqual([]);
  expect(report.vatReturn.filter(line => line.documentIds.length)).toEqual([
    { line: "40", netAmount: "8115.41", vatAmount: "1704.15", documentIds: ["foreign"] },
    { line: "41", netAmount: "2435.72", vatAmount: "292.38", documentIds: ["foreign"] },
  ]);
  expect(report.totals.inputVat).toBe("1996.53");
  expect(report.controlStatement[0].section).toBe("B.2");
  expect(payload.totals).toEqual({ netAmount: "2000.30", vatAmount: "330.04", grossAmount: "2330.34" });
  expect(payload.partialClaim.rateBreakdown).toEqual([
    { rate: 21, netAmount: "333.35", vatAmount: "70.00" },
    { rate: 12, netAmount: "100.05", vatAmount: "12.01" },
  ]);
  const details: ExportDetails = {
    taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", preparedOn: "2026-10-27",
    personType: "P", email: "qa@example.test", phone: "", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
  };
  const returnXml = await createEpoXml(report, "dphdp3", details);
  const controlXml = await createEpoXml(report, "dphkh1", details);
  if (!returnXml.ok || !controlXml.ok) throw new Error("Statutory XML validation refused the foreign Partial Claim");
  expect(returnXml.value).toContain('pln23="8115" odp_tuz23_nar="1704" pln5="2436" odp_tuz5_nar="292"');
  expect(controlXml.value).toMatch(/<VetaB2\b[^>]*pomer="N"[^>]*zakl_dane1="8115\.41" dan1="1704\.15"[^>]*zakl_dane2="2435\.72" dan2="292\.38"/);
  const returnPdf = await createVatReturnPdf(vatReturnPreviewData(report));
  const controlPdf = await createControlStatementPdf({ company, period: "2026-10", details }, prepareControlStatement(report));
  expect(await fields(returnPdf, 2, [
    [283.46, 479.17, 378.32, 493.34], [378.32, 479.17, 464.82, 493.34],
    [283.46, 493.34, 378.32, 507.51], [378.32, 493.34, 464.82, 507.51],
  ])).toEqual(["8115", "1704", "2436", "292"]);
  expect(await fields(controlPdf, 2, [[371, 148, 441, 161], [441, 148, 510, 161], [510, 148, 580, 161], [580, 148, 649, 161]]))
    .toEqual(["8115.41", "1704.15", "2435.72", "292.38"]);
});
