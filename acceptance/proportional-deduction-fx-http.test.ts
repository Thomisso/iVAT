import * as XLSX from "xlsx";
import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { approveDocument, correctDocument, createManualDocument, listExtractionVersions, saveAndApproveDocument } from "@/application/documents";
import { generateVatReport, finalizeVatReport, getVatReport } from "@/application/vat-reports";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { readVatReportArtifact } from "@/application/epo-export";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { fakeExchangeRates } from "@/cnb/fake";
import { administratorWithCompany } from "../tests/support/fixtures";
import { httpAs, value } from "./support/http";

it.each([
  { currency: "EUR", label: "EUR", reportNet: "1500.00", reportVat: "315.00", xmlNet: "1500", xmlVat: "315" },
  { currency: "CZK", label: "Kč", reportNet: "60.00", reportVat: "12.60", xmlNet: "60", xmlVat: "13" },
])("$currency proportional summaries retain original units in detail, list and readiness while exports retain CZK", async ({ currency, label, reportNet, reportVat, xmlNet, xmlVat }) => {
  const company = await administratorWithCompany();
  const registry = fakeVatPayerRegistry();
  const rates = fakeExchangeRates("25.00");
  const payload = { ...SAMPLE_EXTRACTION, documentNumber: `HTTP-SUMMARY-${currency}`, currency,
    rateBreakdown: [{ rate: 21, netAmount: "100.00", vatAmount: "21.00" }],
    totals: { netAmount: "100.00", vatAmount: "21.00", grossAmount: "121.00" },
    claimEligibility: { period: "2026-10", origin: "user" as const, confirmed: true } };
  const document = value(await createManualDocument(company.client, { companyId: company.companyId, payload }, rates, registry));
  const corrected = value(await correctDocument(company.client, { companyId: company.companyId, documentId: document.id, basedOnVersion: 1,
    payload: { ...payload, proportionalDeduction: { percentage: 60, origin: "user", confirmed: true, operatingExpenseConfirmed: true, actualUseConfirmed: true } } }, rates, registry));
  const request = await httpAs(company.client);
  for (const route of [`documents/${document.id}`, "documents?view=all", "vat-reports?period=2026-10"]) {
    const response = await request(`/companies/${company.companyId}/${route}`);
    expect(response.status).toBe(200);
    const html = (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
    const summary = html.match(/<div\b[^>]*aria-label="Live VAT calculation"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    expect(summary, `shared summary rendered on ${route}`).toBeDefined();
    const text = summary!.replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
    expect.soft(text, route).toContain(`Claimed net + VAT: 60,00 ${label} + 12,60 ${label}`);
  }
  value(await approveDocument(company.client, { companyId: company.companyId, documentId: document.id, version: corrected.version }));
  value(await saveCompanyFilingDefaults(company.client, { companyId: company.companyId, taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka", email: "http@example.test", phone: "", epoAddressOverride: null }));
  value(await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" }));
  const report = (await getVatReport(company.client, company.companyId, "2026-10"))!;
  expect(report.result.vatReturn.find(line => line.line === "40")).toMatchObject({ netAmount: reportNet, vatAmount: reportVat });
  value(await finalizeVatReport(company.client, { companyId: company.companyId, period: "2026-10", confirmed: true }));
  const prefix = `/companies/${company.companyId}/vat-reports/2026-10`;
  for (const format of ["dphdp3", "dphkh1"]) {
    const response = await request(`${prefix}/xml`, { method: "POST", body: new URLSearchParams({ format, kind: "final" }) });
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const xml = new TextDecoder().decode(bytes);
    expect(xml).toContain(format === "dphdp3" ? `pln23="${xmlNet}" odp_tuz23_nar="${xmlVat}"` : `zakl_dane1="${reportNet}" dan1="${reportVat}"`);
    expect((await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: response.headers.get("x-ivat-artifact-id")! }))?.bytes).toEqual(bytes);
  }
  const workbook = await request(`${prefix}/xlsx`);
  expect(workbook.status).toBe(200);
  const sheets = XLSX.read(await workbook.arrayBuffer(), { type: "array" });
  expect(XLSX.utils.sheet_to_json(sheets.Sheets.Included)).toMatchObject([{ Currency: currency, "Claimed net amount": 60,
    "Claimed VAT amount": 12.6, "Unclaimed net amount": 40, "Unclaimed VAT amount": 8.4 }]);
});

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
  const refusedHtml = await refused.text();
  const proportionalSection = refusedHtml.match(/<fieldset[^>]*id="proportional-deduction"[^>]*>([\s\S]*?)<\/fieldset>/)?.[1];
  const conversionAlert = proportionalSection?.match(/<div class="iv-notice iv-notice-danger" role="alert">([\s\S]*?)<\/div><\/div>/)?.[1];
  expect(conversionAlert, "conversion blocker uses the danger Notice inside the proportional controls").toBeDefined();
  expect(conversionAlert).toContain("A valid saved CZK conversion of the full Document is required");
  expect(conversionAlert).toMatch(/<svg\b[^>]*aria-hidden="true"/);
});
