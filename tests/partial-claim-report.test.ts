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
