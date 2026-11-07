import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { listPlatformAiUsage } from "@/application/ai-usage";
import { correctDocument, createManualDocument, getDocument, listDocuments, listExtractionVersions } from "@/application/documents";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { uploadSourceFile } from "@/application/source-files";
import { fakeExchangeRates } from "@/cnb/fake";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany, assignAiConfigurationFixture } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { promotedSuperAdministrator } from "./support/platform";
import { testWorker } from "./support/worker";

it.each(["AI", "manual creation", "correction"] as const)("prepares original amounts, ČNB conversion and findings for %s without changing source-specific authorship", async (path) => {
  const company = await administratorWithCompany();
  const payload: ExtractionPayload = {
    ...SAMPLE_EXTRACTION,
    direction: path === "AI" ? "outgoing" : "incoming",
    currency: path === "AI" ? "EUR" : " eur ",
    supplier: { ...SAMPLE_EXTRACTION.supplier, vatId: path === "AI" ? "CZ27082440" : "cz 27082440" },
    rateBreakdown: [
      { rate: 0, netAmount: "0.00", vatAmount: "0.00" },
      { rate: 21, netAmount: path === "AI" ? "100.00" : "100,0", vatAmount: "21.00" },
    ],
    totals: { netAmount: "100.00", vatAmount: "21.00", grossAmount: "121.10" },
    confidence: { documentNumber: 0.98, "rateBreakdown.1.vatAmount": 0.95 },
  };
  const rates = fakeExchangeRates("25.00");
  const registry = fakeVatPayerRegistry({ outcome: "checked", unreliable: true, publishedAccounts: [] });
  let documentId: string;
  let previousVersions: Awaited<ReturnType<typeof listExtractionVersions>> = [];
  if (path === "AI") {
    const worker = testWorker(fakeAiProvider({ extract: () => payload }), registry, rates);
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    const uploaded = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
    if (!uploaded.ok) throw new Error(uploaded.error);
    expect(await worker.runJobs()).toEqual([]);
    const [document] = await listDocuments(company.client, company.companyId, uploaded.value.id);
    documentId = document.id;
  } else {
    const created = await createManualDocument(company.client, { companyId: company.companyId, payload: path === "correction" ? SAMPLE_EXTRACTION : payload }, rates, registry);
    if (!created.ok) throw new Error(created.error);
    documentId = created.value.id;
    if (path === "correction") {
      previousVersions = await listExtractionVersions(company.client, company.companyId, documentId);
      expect(await correctDocument(company.client, { companyId: company.companyId, documentId, basedOnVersion: 1, payload }, rates, registry))
        .toEqual({ ok: true, value: { version: 2 } });
    }
  }
  const versions = await listExtractionVersions(company.client, company.companyId, documentId);
  const version = versions.at(-1)!;
  expect(versions.slice(0, previousVersions.length)).toEqual(previousVersions);
  expect(version.author).toEqual(path === "AI" ? { kind: "ai" } : { kind: "user", userId: company.userId });
  expect(version.payload).toMatchObject({
    direction: "incoming", currency: "EUR", supplier: { vatId: "CZ27082440" },
    rateBreakdown: [{ rate: 21, netAmount: "100.00", vatAmount: "21.00" }],
    totals: { netAmount: "100.00", vatAmount: "21.00", grossAmount: "121.10" },
    czkConversion: {
      originalCurrency: "EUR", rate: "25.00", unit: 1, rateDate: "2026-10-01", source: "CNB",
      rateBreakdown: [{ rate: 21, netAmount: "2500.00", vatAmount: "525.00" }],
      totals: { netAmount: "2500.00", vatAmount: "525.00", grossAmount: "3027.50" },
    },
  });
  expect(version.findings).toEqual([
    { field: "totals.grossAmount", severity: "warning", code: "total_gross_amount_mismatch", params: { difference: "0.10" } },
    { field: "supplier.vatId", severity: "warning", code: "unreliable_vat_payer" },
    { field: "payment.bankAccount", severity: "warning", code: "unpublished_bank_account" },
  ]);
  if (path === "AI") {
    expect(version.payload.confidence).toEqual({ documentNumber: 0.98, "rateBreakdown.0.vatAmount": 0.95 });
  } else {
    expect(version.payload).not.toHaveProperty("confidence");
    expect(await getDocument(company.client, company.companyId, documentId)).toMatchObject({ sourceFileId: null, importDate: null, firstPage: null, lastPage: null });
  }
  expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: path === "AI" ? 1 : 0 } });
  expect(payload.confidence).toEqual({ documentNumber: 0.98, "rateBreakdown.1.vatAmount": 0.95 });
  expect(payload.rateBreakdown).toHaveLength(2);
});

it("refuses invalid or inaccessible manual corrections before external preparation and preserves refusal precedence", async () => {
  const company = await administratorWithCompany();
  const input = { companyId: company.companyId, documentId: randomUUID(), basedOnVersion: 1 };
  const rates = { rateFor: async (): Promise<never> => { throw new Error("Refused input must not request a rate"); } };
  const registry = { check: async (): Promise<never> => { throw new Error("Refused input must not request a registry check"); } };
  expect(await correctDocument(company.client, { ...input, payload: { ...SAMPLE_EXTRACTION, currency: "EUR", taxPointDate: null } }, rates, registry))
    .toEqual({ ok: false, error: "tax_point_date_required", findings: [{ field: "taxPointDate", severity: "error", code: "tax_point_date_required" }] });
  expect(await correctDocument(company.client, { ...input, payload: { ...SAMPLE_EXTRACTION, currency: "EUR" } }, rates, registry))
    .toEqual({ ok: false, error: "forbidden" });
});

it("records AI provider usage after conversion and before registry enrichment while consuming allowance only for the saved Extraction", async () => {
  const company = await administratorWithCompany();
  const operator = await promotedSuperAdministrator("Observe AI preparation metering");
  const usageAtPreparation: number[] = [];
  const allowanceAtPreparation: number[] = [];
  async function observeUsage() {
    const result = await listPlatformAiUsage(operator.client, {
      from: "2000-01-01", to: "2100-01-01", companyId: company.companyId, operation: "extract", groupBy: "operation",
    });
    if (!result.ok) throw new Error(result.error);
    usageAtPreparation.push(result.value[0]?.requests ?? 0);
    const allowance = await getCompanyAiProcessingAllowance(company.client, company.companyId);
    if (!allowance.ok) throw new Error(allowance.error);
    allowanceAtPreparation.push(allowance.value.used);
  }
  const worker = testWorker(fakeAiProvider({ extract: () => ({ ...SAMPLE_EXTRACTION, currency: "EUR" }) }), {
    async check() {
      await observeUsage();
      return { outcome: "unavailable" };
    },
  }, {
    async rateFor(date, currency) {
      await observeUsage();
      return { currency, requestedDate: date, rateDate: date, unit: 1, rate: "25.00", source: "CNB" };
    },
  });
  await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  const uploaded = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toEqual([]);
  expect(usageAtPreparation).toEqual([0, 1]);
  expect(allowanceAtPreparation).toEqual([0, 0]);
  const [document] = await listDocuments(company.client, company.companyId, uploaded.value.id);
  expect(document.status).toBe("needs_review");
  expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
});
