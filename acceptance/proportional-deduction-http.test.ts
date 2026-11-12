import * as XLSX from "xlsx";
import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { createManualDocument, saveAndApproveDocument } from "@/application/documents";
import { generateVatReport, finalizeVatReport } from "@/application/vat-reports";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { readVatReportArtifact } from "@/application/epo-export";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany } from "../tests/support/fixtures";
import { provisionedUser } from "../tests/support/clients";
import { httpAs, value } from "./support/http";

it("authenticated review and final XML/PDF/XLSX downloads preserve the manually confirmed proportional claim", async () => {
  const company = await administratorWithCompany();
  const registry = fakeVatPayerRegistry();
  const payload = { ...SAMPLE_EXTRACTION, documentNumber: "HTTP-PROPORTIONAL-50",
    rateBreakdown: [{ rate: 21, netAmount: "12000.00", vatAmount: "2520.00" }],
    totals: { netAmount: "12000.00", vatAmount: "2520.00", grossAmount: "14520.00" },
    claimEligibility: { period: "2026-10", origin: "user" as const, confirmed: true } };
  const document = value(await createManualDocument(company.client, { companyId: company.companyId, payload }, undefined, registry));
  value(await saveAndApproveDocument(company.client, { companyId: company.companyId, documentId: document.id, basedOnVersion: 1,
    requestId: crypto.randomUUID(), payload: { ...payload, proportionalDeduction: { percentage: 50, origin: "user", confirmed: true, operatingExpenseConfirmed: true, actualUseConfirmed: true } } }, undefined, registry));
  const request = await httpAs(company.client);
  const review = await request(`/companies/${company.companyId}/documents/${document.id}`);
  expect(review.status).toBe(200);
  const html = await review.text();
  expect(html).toContain("Proportional deduction (§ 75)");
  expect(html).toMatch(/name="proportionalDeduction.percentage"[^>]*value="50"/);
  expect(html).toContain("Original net + VAT");
  expect(html).toContain("Claimed net + VAT");
  value(await saveCompanyFilingDefaults(company.client, { companyId: company.companyId, taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka", email: "http@example.test", phone: "", epoAddressOverride: null }));
  value(await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" }));
  value(await finalizeVatReport(company.client, { companyId: company.companyId, period: "2026-10", confirmed: true }));
  const prefix = `/companies/${company.companyId}/vat-reports/2026-10`;
  for (const format of ["dphdp3", "dphkh1"]) {
    const response = await request(`${prefix}/xml`, { method: "POST", body: new URLSearchParams({ format, kind: "final" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toMatch(format === "dphkh1" ? /pomer="A"[^>]*zakl_dane1="6000.00" dan1="1260.00"/ : /pln23="6000" odp_tuz23_nar="1260"/);
    const artifactId = response.headers.get("x-ivat-artifact-id")!;
    expect((await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId }))?.bytes).toEqual(bytes);
    const outsider = await provisionedUser();
    expect((await (await httpAs(outsider.client))(`${prefix}/artifacts/${artifactId}`)).status).toBe(404);
  }
  for (const path of ["pdf", "control-statement/pdf"]) {
    const response = await request(`${prefix}/${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode((await response.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
  }
  const workbook = await request(`${prefix}/xlsx`);
  expect(workbook.status).toBe(200);
  const sheets = XLSX.read(await workbook.arrayBuffer(), { type: "array" });
  expect(XLSX.utils.sheet_to_json(sheets.Sheets.Included)).toMatchObject([{ "Deduction mode": "Proportional deduction", "Ratio (%)": 50, "Net amount": 12000, "Claimed net amount": 6000, "Claimed VAT amount": 1260, "Unclaimed net amount": 6000, "Unclaimed VAT amount": 1260 }]);
  const czech = await (await httpAs(company.client, "cs"))(`${prefix}/xlsx`);
  expect(czech.status).toBe(200);
  const czechSheets = XLSX.read(await czech.arrayBuffer(), { type: "array" });
  expect(XLSX.utils.sheet_to_json(czechSheets.Sheets["Zahrnuté"])).toMatchObject([{ "Režim odpočtu": "Poměrný odpočet", "Uplatněný základ": 6000 }]);
});
