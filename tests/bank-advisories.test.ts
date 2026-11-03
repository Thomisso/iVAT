import { expect, it } from "vitest";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { approveDocument, correctDocument, listDocuments, listExtractionVersions } from "@/application/documents";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { uploadSourceFile } from "@/application/source-files";
import { finalizeVatReport, generateVatReport, getVatReport } from "@/application/vat-reports";
import { administratorWithCompany, assignAiConfigurationFixture } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { fakeExchangeRates } from "@/cnb/fake";
import type { ExtractionPayload } from "@/application/extraction-payload";
import type { VatPayerRegistry } from "@/application/vat-registry";

async function documentInBankReview(payload: ExtractionPayload = SAMPLE_EXTRACTION, registry: VatPayerRegistry = fakeVatPayerRegistry()) {
  const company = await administratorWithCompany();
  const worker = testWorker(fakeAiProvider({ extract: () => payload }), registry);
  await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  const upload = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png"),
  });
  if (!upload.ok) throw new Error(upload.error);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(company.client, company.companyId, upload.value.id);
  return { company, document };
}

it.each([
  {
    label: "missing account", code: "missing_bank_account", field: "payment.bankAccount",
    payload: { ...SAMPLE_EXTRACTION, payment: { ...SAMPLE_EXTRACTION.payment, bankAccount: null, iban: null } },
    registry: fakeVatPayerRegistry(),
  },
  {
    label: "unpublished account", code: "unpublished_bank_account", field: "payment.bankAccount", payload: SAMPLE_EXTRACTION,
    registry: fakeVatPayerRegistry({ outcome: "checked", unreliable: false, publishedAccounts: [] }),
  },
  {
    label: "unavailable registry", code: "vat_registry_check_not_performed", field: "supplier.vatId", payload: SAMPLE_EXTRACTION,
    registry: fakeVatPayerRegistry({ outcome: "unavailable" }),
  },
  {
    label: "failed registry", code: "vat_registry_check_not_performed", field: "supplier.vatId", payload: SAMPLE_EXTRACTION,
    registry: { async check(): Promise<never> { throw new Error("registry unavailable"); } },
  },
  {
    label: "supplier not found", code: "bank_account_not_verified", field: "payment.bankAccount", payload: SAMPLE_EXTRACTION,
    registry: fakeVatPayerRegistry({ outcome: "not_found" }),
  },
  {
    label: "contradictory representations", code: "inconsistent_payment_account", field: "payment.bankAccount",
    payload: { ...SAMPLE_EXTRACTION, payment: { ...SAMPLE_EXTRACTION.payment, bankAccount: "2000145399/0800", iban: "CZ6508000000192000145399" } },
    registry: fakeVatPayerRegistry({ outcome: "checked", unreliable: false, publishedAccounts: ["19-2000145399/0800"] }),
  },
  {
    label: "gateway identifier", code: "unrecognized_payment_account", field: "payment.bankAccount",
    payload: { ...SAMPLE_EXTRACTION, payment: { ...SAMPLE_EXTRACTION.payment, bankAccount: "gateway-order-123" } },
    registry: fakeVatPayerRegistry(),
  },
])("keeps $label advisory through human review, reporting and Finalization", async ({ payload, registry, code, field }) => {
  const { company, document } = await documentInBankReview(payload, registry);
  expect(document.status).toBe("needs_review");
  expect((await listExtractionVersions(company.client, company.companyId, document.id))[0].findings)
    .toEqual([{ field, severity: "warning", code }]);
  const period = { companyId: company.companyId, period: "2026-10" };
  expect((await generateVatReport(company.client, period)).ok).toBe(true);
  expect(await finalizeVatReport(company.client, { ...period, confirmed: true }))
    .toEqual({ ok: false, error: "readiness_blocked" });
  expect(await approveDocument(company.client, { companyId: company.companyId, documentId: document.id, version: 1 }))
    .toEqual({ ok: true, value: null });
  const readiness = await getReportingPeriodReadiness(company.client, period);
  expect(readiness).toEqual({ ok: true, value: expect.objectContaining({
    ready: true, blockers: [], warnings: [expect.objectContaining({ findingCode: code })],
  }) });
  expect((await generateVatReport(company.client, period)).ok).toBe(true);
  expect((await getVatReport(company.client, company.companyId, period.period))?.result.totals.inputVat).toBe("210.00");
  expect(await finalizeVatReport(company.client, { ...period, confirmed: true })).toEqual({ ok: true, value: null });
});

it("preserves the extracted Payment Account and rechecks both corrected representations as one account", async () => {
  const payment = { ...SAMPLE_EXTRACTION.payment, bankAccount: "000019-02000145399 / 0800", iban: "cz65 0800 0000 1920 0014 5399" };
  const registry = fakeVatPayerRegistry({ outcome: "checked", unreliable: true, publishedAccounts: ["19-2000145399/0800"] });
  const { company, document } = await documentInBankReview({ ...SAMPLE_EXTRACTION, payment }, registry);
  const reliability = { field: "supplier.vatId", severity: "warning", code: "unreliable_vat_payer" };
  expect((await listExtractionVersions(company.client, company.companyId, document.id))[0]).toMatchObject({
    payload: { payment }, findings: [reliability],
  });
  expect(await correctDocument(company.client, {
    companyId: company.companyId, documentId: document.id, basedOnVersion: 1,
    payload: { ...SAMPLE_EXTRACTION, payment: { ...payment, bankAccount: "2000145399/0800" } },
  }, fakeExchangeRates(), registry)).toEqual({ ok: true, value: { version: 2 } });
  const versions = await listExtractionVersions(company.client, company.companyId, document.id);
  expect(versions[0]).toMatchObject({ payload: { payment }, findings: [reliability] });
  expect(versions[1].findings).toEqual([
    reliability, { field: "payment.bankAccount", severity: "warning", code: "inconsistent_payment_account" },
  ]);
  expect(await correctDocument(company.client, {
    companyId: company.companyId, documentId: document.id, basedOnVersion: 2,
    payload: { ...SAMPLE_EXTRACTION, payment: { ...payment, bankAccount: "19-2000145399/0800" } },
  }, fakeExchangeRates(), registry)).toEqual({ ok: true, value: { version: 3 } });
  expect((await listExtractionVersions(company.client, company.companyId, document.id))[2].findings).toEqual([reliability]);
});

it("checks an outgoing Document's own-Company receiving account through extraction and correction", async () => {
  const payload: ExtractionPayload = { ...SAMPLE_EXTRACTION,
    supplier: SAMPLE_EXTRACTION.customer, customer: SAMPLE_EXTRACTION.supplier,
    payment: { ...SAMPLE_EXTRACTION.payment, bankAccount: "19-2000145399/0800", iban: "CZ6508000000192000145399" },
  };
  const registry: VatPayerRegistry = { check: async (vatId) => ({
    outcome: "checked", unreliable: false, publishedAccounts: vatId === "CZ25596641" ? ["19-2000145399/0800"] : [],
  }) };
  const { company, document } = await documentInBankReview(payload, registry);
  const [extracted] = await listExtractionVersions(company.client, company.companyId, document.id);
  expect(extracted).toMatchObject({ payload: { direction: "outgoing" }, findings: [] });
  expect(await correctDocument(company.client, {
    companyId: company.companyId, documentId: document.id, basedOnVersion: 1,
    payload: { ...extracted.payload, payment: { ...payload.payment, bankAccount: "2000145399/0800", iban: null } },
  }, fakeExchangeRates(), registry)).toEqual({ ok: true, value: { version: 2 } });
  expect((await listExtractionVersions(company.client, company.companyId, document.id))[1].findings).toEqual([
    { field: "payment.bankAccount", severity: "warning", code: "unpublished_own_bank_account" },
  ]);
  expect(await approveDocument(company.client, { companyId: company.companyId, documentId: document.id, version: 2 }))
    .toEqual({ ok: true, value: null });
  expect((await listDocuments(company.client, company.companyId, document.sourceFileId!)).find((item) => item.id === document.id)?.status).toBe("approved");
});

it("rechecks a corrected payment account and records an unpublished-account advisory on the new Version", async () => {
  const { company, document } = await documentInBankReview();
  const corrected = { ...SAMPLE_EXTRACTION, payment: { ...SAMPLE_EXTRACTION.payment, bankAccount: "999999/0100" } };
  expect(await correctDocument(company.client, {
    companyId: company.companyId, documentId: document.id, basedOnVersion: 1, payload: corrected,
  }, fakeExchangeRates(), fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
  const versions = await listExtractionVersions(company.client, company.companyId, document.id);
  expect(versions[0].findings).toEqual([]);
  expect(versions[1].findings).toEqual([{
    field: "payment.bankAccount", severity: "warning", code: "unpublished_bank_account",
  }]);
});

it("warns for an older missing-account Version without rewriting its stored findings", async () => {
  const { company, document } = await documentInBankReview();
  const older = await company.client.rpc("correct_document", {
    target_document_id: document.id, based_on_version: 1,
    payload: { ...SAMPLE_EXTRACTION, payment: { ...SAMPLE_EXTRACTION.payment, bankAccount: null, iban: null } }, findings: [],
  });
  expect(older.error).toBeNull();
  const versions = await listExtractionVersions(company.client, company.companyId, document.id);
  expect(versions[1].findings).toEqual([{ field: "payment.bankAccount", severity: "warning", code: "missing_bank_account" }]);
  expect((await company.client.from("extraction_version").select("findings").eq("id", versions[1].id).single()).data?.findings)
    .toEqual([]);
  expect(await approveDocument(company.client, { companyId: company.companyId, documentId: document.id, version: 2 }))
    .toEqual({ ok: true, value: null });
  const period = { companyId: company.companyId, period: "2026-10" };
  expect((await generateVatReport(company.client, period)).ok).toBe(true);
  expect((await getVatReport(company.client, company.companyId, period.period))?.finalization.warningCount).toBe(1);
  expect(await finalizeVatReport(company.client, { ...period, confirmed: true })).toEqual({ ok: true, value: null });
});
