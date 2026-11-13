import * as XLSX from "xlsx";
import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { createManualDocument, listExtractionVersions, saveAndApproveDocument } from "@/application/documents";
import { generateVatReport, finalizeVatReport } from "@/application/vat-reports";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { readVatReportArtifact } from "@/application/epo-export";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { fakeExchangeRates } from "@/cnb/fake";
import { administratorWithCompany } from "../tests/support/fixtures";
import { httpAs, value } from "./support/http";

it("authenticated foreign proportional review and XML/XLSX downloads use the saved full-Document fixing", async () => {
  const company = await administratorWithCompany();
  const registry = fakeVatPayerRegistry();
  const rates = fakeExchangeRates("2434.50", 100);
  const payload = { ...SAMPLE_EXTRACTION, documentNumber: "HTTP-FOREIGN-PROPORTIONAL", currency: "EUR",
    rateBreakdown: [{ rate: 21, netAmount: "1000.00", vatAmount: "210.00" }],
    totals: { netAmount: "1000.00", vatAmount: "210.00", grossAmount: "1210.00" },
    claimEligibility: { period: "2026-10", origin: "user" as const, confirmed: true } };
  const ratio = { percentage: 50, origin: "user" as const, confirmed: true, operatingExpenseConfirmed: true, actualUseConfirmed: true };
  const document = value(await createManualDocument(company.client, { companyId: company.companyId, payload }, rates, registry));
  value(await saveAndApproveDocument(company.client, { companyId: company.companyId, documentId: document.id, basedOnVersion: 1,
    requestId: crypto.randomUUID(), payload: { ...payload, proportionalDeduction: ratio } }, rates, registry));
  const request = await httpAs(company.client);
  const review = await request(`/companies/${company.companyId}/documents/${document.id}`);
  expect(review.status).toBe(200);
  expect(await review.text()).toContain("Foreign amounts use the full Document’s saved CZK conversion.");
  value(await saveCompanyFilingDefaults(company.client, { companyId: company.companyId, taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka", email: "http@example.test", phone: "", epoAddressOverride: null }));
  value(await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" }));
  value(await finalizeVatReport(company.client, { companyId: company.companyId, period: "2026-10", confirmed: true }));
  const prefix = `/companies/${company.companyId}/vat-reports/2026-10`;
  for (const format of ["dphdp3", "dphkh1"]) {
    const response = await request(`${prefix}/xml`, { method: "POST", body: new URLSearchParams({ format, kind: "final" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toMatch(format === "dphkh1" ? /pomer="A"[^>]*zakl_dane1="12172.50" dan1="2556.23"/ : /pln23="12173" odp_tuz23_nar="2556"/);
    expect((await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: response.headers.get("x-ivat-artifact-id")! }))?.bytes).toEqual(bytes);
  }
  const workbook = await request(`${prefix}/xlsx`);
  expect(workbook.status).toBe(200);
  const sheets = XLSX.read(await workbook.arrayBuffer(), { type: "array" });
  expect(XLSX.utils.sheet_to_json(sheets.Sheets.Included)).toMatchObject([{ Currency: "EUR", "Claimed net amount": 500,
    "Claimed VAT amount": 105, "Unclaimed net amount": 500, "Unclaimed VAT amount": 105 }]);
  const czech = await (await httpAs(company.client, "cs"))(`/companies/${company.companyId}/documents/${document.id}`);
  expect(czech.status).toBe(200);
  expect(await czech.text()).toContain("Cizí měna používá uložený přepočet celého dokladu do CZK.");

  const malformed = value(await createManualDocument(company.client, { companyId: company.companyId,
    payload: { ...payload, documentNumber: "HTTP-FOREIGN-MALFORMED", taxPointDate: "2026-11-01", issueDate: "2026-11-01",
      claimEligibility: { period: "2026-11", origin: "user", confirmed: true } } }, rates, registry));
  const original = (await listExtractionVersions(company.client, company.companyId, malformed.id))[0].payload;
  expect((await company.client.rpc("correct_document", { target_document_id: malformed.id, based_on_version: 1,
    payload: { ...original, proportionalDeduction: ratio, czkConversion: { ...original.czkConversion!, rateBreakdown: null } }, findings: [] })).error).toBeNull();
  const refused = await request(`/companies/${company.companyId}/documents/${malformed.id}`);
  expect(refused.status).toBe(200);
  expect(await refused.text()).toContain("A valid saved CZK conversion of the full Document is required");
});
