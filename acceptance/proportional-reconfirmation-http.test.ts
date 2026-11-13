import * as XLSX from "xlsx";
import { getDocument as readPdf } from "pdfjs-dist/legacy/build/pdf.mjs";
import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { correctDocument, createManualDocument, listExtractionVersions, returnDocumentToReview, saveAndApproveDocument } from "@/application/documents";
import { finalizeVatReport, generateVatReport, unlockReportingPeriod } from "@/application/vat-reports";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { proportionalDeductionBasis } from "@/application/proportional-deduction";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany } from "../tests/support/fixtures";
import { provisionedUser } from "../tests/support/clients";
import { httpAs, inputTag, value } from "./support/http";

async function pdfText(bytes: ArrayBuffer) {
  const task = readPdf({ data: new Uint8Array(bytes) });
  try {
    const pdf = await task.promise;
    return (await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) =>
      (await (await pdf.getPage(index + 1)).getTextContent()).items.flatMap(item => "str" in item ? [item.str] : []).join(" ")))).join("\n");
  } finally { await task.destroy(); }
}

it("HTTP review explains retained percentage and fresh XML/PDF/XLSX follow reconfirmation while archived XML bytes remain unchanged", async () => {
  const company = await administratorWithCompany();
  const registry = fakeVatPayerRegistry();
  const payload = { ...SAMPLE_EXTRACTION, documentNumber: "HTTP-RECONFIRM-50",
    rateBreakdown: [{ rate: 21, netAmount: "12000.00", vatAmount: "2520.00" }],
    totals: { netAmount: "12000.00", vatAmount: "2520.00", grossAmount: "14520.00" },
    claimEligibility: { period: "2026-10", origin: "user" as const, confirmed: true } };
  const document = value(await createManualDocument(company.client, { companyId: company.companyId, payload }, undefined, registry));
  const input = { companyId: company.companyId, documentId: document.id };
  const ratio = { percentage: 50, origin: "user" as const, confirmed: true, operatingExpenseConfirmed: true, actualUseConfirmed: true };
  value(await saveAndApproveDocument(company.client, { ...input, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...payload, proportionalDeduction: ratio } }, undefined, registry));
  value(await saveCompanyFilingDefaults(company.client, { companyId: company.companyId, taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka", email: "http@example.test", phone: "", epoAddressOverride: null }));
  value(await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" }));
  value(await finalizeVatReport(company.client, { companyId: company.companyId, period: "2026-10", confirmed: true }));
  const request = await httpAs(company.client);
  const prefix = `/companies/${company.companyId}/vat-reports/2026-10`;
  const archived: { id: string; bytes: Uint8Array }[] = [];
  for (const format of ["dphdp3", "dphkh1"]) {
    const response = await request(`${prefix}/xml`, { method: "POST", body: new URLSearchParams({ format, kind: "final" }) });
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toMatch(format === "dphkh1" ? /pomer="A"[^>]*zakl_dane1="6000.00" dan1="1260.00"/ : /pln23="6000" odp_tuz23_nar="1260"/);
    archived.push({ id: response.headers.get("x-ivat-artifact-id")!, bytes });
  }
  expect(await returnDocumentToReview(company.client, input)).toEqual({ ok: false, error: "period_locked" });
  value(await unlockReportingPeriod(company.client, { companyId: input.companyId, period: "2026-10", confirmed: true, reason: "Correct source amounts" }));
  value(await returnDocumentToReview(company.client, input));
  const changed = { ...payload, rateBreakdown: [{ rate: 21, netAmount: "20000.00", vatAmount: "4200.00" }],
    totals: { netAmount: "20000.00", vatAmount: "4200.00", grossAmount: "24200.00" } };
  value(await correctDocument(company.client, { ...input, basedOnVersion: 2, payload: changed }, undefined, registry));
  const review = await request(`/companies/${company.companyId}/documents/${document.id}`);
  expect(review.status).toBe(200);
  const html = await review.text();
  expect(inputTag(html, "proportionalDeduction.percentage")).toContain('value="50"');
  expect(inputTag(html, "proportionalDeduction.confirmed")).toContain('value="false"');
  expect(html).toContain("Previous ratio: 50 %. Confirm it again for the current data.");
  expect(html).toContain("Export and Finalization do not submit a tax return or perform an annual correction.");
  expect(html).toContain("earliestClaimPeriod");
  const outsider = await provisionedUser();
  expect((await (await httpAs(outsider.client))(`/companies/${company.companyId}/documents/${document.id}`)).status).toBe(404);
  const current = (await listExtractionVersions(company.client, input.companyId, input.documentId)).at(-1)!.payload;
  value(await saveAndApproveDocument(company.client, { ...input, basedOnVersion: 3, requestId: crypto.randomUUID(), payload: {
    ...current, proportionalDeduction: { ...current.proportionalDeduction!, percentage: 60, confirmed: true, basis: proportionalDeductionBasis(current) },
  } }, undefined, registry));
  value(await generateVatReport(company.client, { companyId: input.companyId, period: "2026-10" }));
  value(await finalizeVatReport(company.client, { companyId: input.companyId, period: "2026-10", confirmed: true }));
  for (const format of ["dphdp3", "dphkh1"]) {
    const response = await request(`${prefix}/xml`, { method: "POST", body: new URLSearchParams({ format, kind: "final" }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(format === "dphkh1" ? /pomer="A"[^>]*zakl_dane1="12000.00" dan1="2520.00"/ : /pln23="12000" odp_tuz23_nar="2520"/);
  }
  for (const path of ["pdf", "control-statement/pdf"]) {
    const response = await request(`${prefix}/${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(await pdfText(await response.arrayBuffer())).toMatch(path === "pdf" ? /12000\s+2520/ : /12000.00\s+2520.00[\s\S]*A/);
  }
  const workbook = await request(`${prefix}/xlsx`);
  expect(workbook.status).toBe(200);
  const sheets = XLSX.read(await workbook.arrayBuffer(), { type: "array" });
  expect(XLSX.utils.sheet_to_json(sheets.Sheets.Included)).toMatchObject([{ "Deduction mode": "Proportional deduction", "Ratio (%)": 60,
    "Net amount": 20000, "VAT amount": 4200, "Claimed net amount": 12000, "Claimed VAT amount": 2520, "Unclaimed net amount": 8000, "Unclaimed VAT amount": 1680 }]);
  for (const artifact of archived) {
    const response = await request(`${prefix}/artifacts/${artifact.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(artifact.bytes);
    expect((await (await httpAs(outsider.client))(`${prefix}/artifacts/${artifact.id}`)).status).toBe(404);
  }
});
