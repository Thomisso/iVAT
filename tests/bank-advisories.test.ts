import { setOctoberImportFixture } from "./support/claim-eligibility";
import { refreshBankAccountCheck, getDocumentBankAccountChecks } from "@/application/bank-account-checks";
import { expect, it } from "vitest";
import { getDocumentReview } from "@/application/document-review";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { approveDocument, correctDocument, documentPeriodLocks, listDocuments, listExtractionVersions } from "@/application/documents";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { uploadSourceFile } from "@/application/source-files";
import { finalizeVatReport, generateVatReport, getVatReport } from "@/application/vat-reports";
import { administratorWithCompany, assignAiConfigurationFixture, companyMember, knownSupplierFixture } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { fakeExchangeRates } from "@/cnb/fake";
import type { ExtractionPayload } from "@/application/extraction-payload";
import type { VatPayerRegistry } from "@/application/vat-registry";

async function documentInBankReview(payload: ExtractionPayload = SAMPLE_EXTRACTION, registry: VatPayerRegistry = fakeVatPayerRegistry()) {
  const company = await administratorWithCompany();
  await knownSupplierFixture(company);
  const worker = testWorker(fakeAiProvider({ extract: () => payload }), registry);
  await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  const upload = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png"),
  });
  if (!upload.ok) throw new Error(upload.error);
  await setOctoberImportFixture(upload.value.id);
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
  const [original] = await listExtractionVersions(company.client, company.companyId, document.id);
  const older = await company.client.rpc("correct_document", {
    target_document_id: document.id, based_on_version: 1,
    payload: { ...original.payload, payment: { ...original.payload.payment, bankAccount: null, iban: null } }, findings: [],
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


it("refreshes a legacy false warning in a locked Approved Document without changing accounting history", async () => {
  const { company, document } = await documentInBankReview();
  const [original] = await listExtractionVersions(company.client, company.companyId, document.id);
  const legacy = await company.client.rpc("correct_document", {
    target_document_id: document.id, based_on_version: 1, payload: original.payload,
    findings: [
      { field: "payment.bankAccount", severity: "warning", code: "unpublished_bank_account" },
      { field: "supplier.vatId", severity: "warning", code: "unreliable_vat_payer" },
    ],
  });
  expect(legacy.error).toBeNull();
  const target = { companyId: company.companyId, documentId: document.id };
  const before = await listExtractionVersions(company.client, target.companyId, target.documentId);
  expect(await getDocumentBankAccountChecks(company.client, target)).toMatchObject({ current: null, checks: [] });
  expect(await approveDocument(company.client, { ...target, version: 2 })).toEqual({ ok: true, value: null });
  const period = { companyId: company.companyId, period: "2026-10" };
  expect((await generateVatReport(company.client, period)).ok).toBe(true);
  expect(await finalizeVatReport(company.client, { ...period, confirmed: true })).toEqual({ ok: true, value: null });
  const report = await getVatReport(company.client, company.companyId, period.period);
  const approved = (await listDocuments(company.client, company.companyId, document.sourceFileId!))[0];
  const result = await refreshBankAccountCheck(company.client, target, fakeVatPayerRegistry());
  expect(result).toMatchObject({ ok: true, value: { outcome: "published", extractionVersionId: before[1].id } });
  const checks = await getDocumentBankAccountChecks(company.client, target);
  expect(checks.current).toMatchObject({ outcome: "published", checkedAt: expect.any(String) });
  expect(checks.findings).toEqual([{ field: "supplier.vatId", severity: "warning", code: "unreliable_vat_payer" }]);
  expect(checks.checks).toHaveLength(1);
  expect(await getDocumentReview(company.client, target)).toMatchObject({
    current: { version: 2 }, shown: { version: 2 }, viewingRecorded: false,
    shownFindings: [{ field: "supplier.vatId", severity: "warning", code: "unreliable_vat_payer" }],
    bankChecks: { current: { version: 2, outcome: "published", checkedAt: expect.any(String) } },
    file: { fileName: "receipt.png" }, sourceRows: null, lockedPeriod: "2026-10", reviewing: false,
  });
  expect(await getDocumentReview(company.client, { ...target, requestedVersion: "2" })).toMatchObject({
    shown: { version: 2 }, viewingRecorded: true,
    shownFindings: [
      { field: "payment.bankAccount", severity: "warning", code: "unpublished_bank_account" },
      { field: "supplier.vatId", severity: "warning", code: "unreliable_vat_payer" },
    ],
  });
  expect(await listExtractionVersions(company.client, target.companyId, target.documentId)).toEqual(before);
  expect((await listDocuments(company.client, company.companyId, document.sourceFileId!))[0]).toEqual(approved);
  expect(await getVatReport(company.client, company.companyId, period.period)).toEqual(report);
  expect(await correctDocument(company.client, { ...target, basedOnVersion: 2, payload: SAMPLE_EXTRACTION }))
    .toEqual({ ok: false, error: "not_in_review" });
  expect(await documentPeriodLocks(company.client, company.companyId, [document.id])).toEqual({ [document.id]: "2026-10" });
});


it("retains a failed new observation instead of freshly verifying an old success", async () => {
  const { company, document } = await documentInBankReview();
  const target = { companyId: company.companyId, documentId: document.id };
  expect(await refreshBankAccountCheck(company.client, target, fakeVatPayerRegistry())).toMatchObject({ ok: true, value: { outcome: "published" } });
  expect(await refreshBankAccountCheck(company.client, target, { async check() { throw new Error("network outage"); } }))
    .toMatchObject({ ok: true, value: { outcome: "unavailable" } });
  const view = await getDocumentBankAccountChecks(company.client, target);
  expect(view.current?.outcome).toBe("unavailable");
  expect(view.checks.map((check) => check.outcome)).toEqual(["unavailable", "published"]);
  expect(view.findings).toEqual([{ field: "supplier.vatId", severity: "warning", code: "vat_registry_check_not_performed" }]);
});

it("keeps a delayed check for the earlier supplier/account as history after correction", async () => {
  const { company, document } = await documentInBankReview();
  const target = { companyId: company.companyId, documentId: document.id };
  let release!: (result: Awaited<ReturnType<VatPayerRegistry["check"]>>) => void;
  let started!: () => void;
  const checking = new Promise<void>((resolve) => { started = resolve; });
  const delayed = refreshBankAccountCheck(company.client, target, { check: async () => {
    started(); return new Promise((resolve) => { release = resolve; });
  } });
  await checking;
  const payload = { ...SAMPLE_EXTRACTION, supplier: { ...SAMPLE_EXTRACTION.supplier, vatId: "CZ45274649" }, payment: { ...SAMPLE_EXTRACTION.payment, bankAccount: "999999/0100" } };
  expect(await correctDocument(company.client, { ...target, basedOnVersion: 1, payload }, fakeExchangeRates(), fakeVatPayerRegistry()))
    .toEqual({ ok: true, value: { version: 2 } });
  release({ outcome: "checked", unreliable: false, publishedAccounts: ["123456789/0100"] });
  expect(await delayed).toMatchObject({ ok: true, value: { outcome: "published", version: 1, supplierVatId: "CZ27082440" } });
  const view = await getDocumentBankAccountChecks(company.client, target);
  expect(view.current).toBeNull();
  expect(view.checks).toHaveLength(1);
  expect(view.findings).toEqual([{ field: "payment.bankAccount", severity: "warning", code: "unpublished_bank_account" }]);
  expect(await getDocumentReview(company.client, target)).toMatchObject({
    current: { version: 2 }, shown: { version: 2 }, viewingRecorded: false,
    shownFindings: [{ field: "payment.bankAccount", severity: "warning", code: "unpublished_bank_account" }],
    bankChecks: { current: null, checks: [{ version: 1, outcome: "published", checkedAt: expect.any(String) }] },
  });
  expect(await getDocumentReview(company.client, { ...target, requestedVersion: "1" })).toMatchObject({
    shown: { version: 1, payload: { supplier: { vatId: "CZ27082440" } } },
    viewingRecorded: true, shownFindings: [],
  });
  expect(await refreshBankAccountCheck(company.client, target, fakeVatPayerRegistry())).toMatchObject({ ok: true, value: { outcome: "unpublished", version: 2, supplierVatId: "CZ45274649" } });
});

it("allows an ordinary Company User to refresh but isolates foreign Organizations and prevents history rewrites", async () => {
  const { company, document } = await documentInBankReview();
  const member = await companyMember(company);
  const foreign = await administratorWithCompany();
  const target = { companyId: company.companyId, documentId: document.id };
  const checked = await refreshBankAccountCheck(member.client, target, fakeVatPayerRegistry());
  expect(checked).toMatchObject({ ok: true, value: { outcome: "published" } });
  if (!checked.ok) throw new Error(checked.error);
  const input = { target_document_id: document.id, checked_version_id: checked.value.extractionVersionId, check_outcome: "published" };
  expect(await refreshBankAccountCheck(foreign.client, target, { check: async () => { throw new Error("must not contact registry"); } }))
    .toEqual({ ok: false, error: "forbidden" });
  expect(await getDocumentBankAccountChecks(foreign.client, target)).toMatchObject({ checks: [], current: null });
  expect(await getDocumentReview(foreign.client, target)).toBeNull();
  expect(await getDocumentReview(company.client, { ...target, companyId: foreign.companyId })).toBeNull();
  expect(await getDocumentReview(member.client, { ...target, requestedVersion: "1" })).toMatchObject({
    document: { id: document.id }, shown: { version: 1 }, viewingRecorded: true,
    bankChecks: { current: { outcome: "published" } },
  });
  expect((await foreign.client.from("bank_account_check").select("id").eq("document_id", document.id)).data).toEqual([]);
  expect((await foreign.client.rpc("record_bank_account_check", input)).error?.code).toBe("42501");
  expect((await foreign.client.from("bank_account_check").insert({
    organization_id: company.organizationId, company_id: company.companyId, document_id: document.id,
    extraction_version_id: checked.value.extractionVersionId, outcome: "published",
  })).error?.code).toBe("42501");
  for (const client of [member.client, foreign.client]) {
    expect((await client.from("bank_account_check").update({ outcome: "unpublished" }).eq("id", checked.value.id)).error?.code).toBe("42501");
    expect((await client.from("bank_account_check").delete().eq("id", checked.value.id)).error?.code).toBe("42501");
  }
  expect((await member.client.rpc("record_bank_account_check", { ...input, checked_version_id: crypto.randomUUID() })).error?.code).toBe("42501");
  expect((await getDocumentBankAccountChecks(member.client, target)).checks).toHaveLength(1);
});

it.each([
  { payment: { bankAccount: "2000145399/0800", iban: "CZ6508000000192000145399", variableSymbol: null }, outcome: "inconsistent" },
  { payment: { bankAccount: "gateway-order-123", iban: null, variableSymbol: null }, outcome: "unrecognized" },
  { payment: { bankAccount: null, iban: null, variableSymbol: null }, outcome: "missing" },
])("retains a distinguishable $outcome manual observation", async ({ payment, outcome }) => {
  const { company, document } = await documentInBankReview({ ...SAMPLE_EXTRACTION, payment });
  expect(await refreshBankAccountCheck(company.client, { companyId: company.companyId, documentId: document.id }, fakeVatPayerRegistry()))
    .toMatchObject({ ok: true, value: { outcome } });
});
