import { expect, inject, it } from "vitest";
import { approveDocument, correctDocument, createManualDocument, listCompanyDocuments, returnDocumentToReview } from "@/application/documents";
import { administratorWithCompany } from "./support/fixtures";
import { setLegacyDocumentApprovedFixture, setLegacyReadinessCountFixture } from "./support/legacy-document-approval";
import { SYNTHETIC_EXCLUDED_PURCHASE } from "./support/truthful-inclusion";
import { exportReportingPeriodWorkbook } from "@/application/reporting-period-excel";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import * as XLSX from "xlsx";
import { finalizeVatReport, generateVatReport, getPeriodLock, getVatReport } from "@/application/vat-reports";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { exportVatReport, readVatReportArtifact } from "@/application/epo-export";
import { createHash } from "node:crypto";
import { excludeSourceFile, getSourceFile, restoreSourceFile, uploadSourceFile } from "@/application/source-files";
import { setCurrentReportingYear } from "@/application/companies";
import { pragueDate } from "@/application/reporting-periods";
import { fixtureFile } from "./support/files";

it("does not label a historical Approved purchase as included when the live Rules Engine excludes its missing supplier identity", async () => {
  const company = await administratorWithCompany();
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload: SYNTHETIC_EXCLUDED_PURCHASE });
  if (!created.ok) throw new Error(created.error);
  await setLegacyDocumentApprovedFixture(inject("databaseUrl"), created.value.id, [
    { field: "payment.bankAccount", severity: "warning", code: "missing_bank_account" },
  ]);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  expect(document.status).toBe("approved");
  expect(document.eligibleForVatReport).toBe(false);
  expect(document.reporting.blockingFindings).toContainEqual({ field: "supplier.vatId", severity: "error", code: "counterparty_vat_id_required" });
  expect(document.reporting.advisoryFindings).toContainEqual({ field: "payment.bankAccount", severity: "warning", code: "missing_bank_account" });
  expect(document.reporting).toEqual(expect.objectContaining({
    exclusionReason: "incomplete_data",
    exclusionDetail: "counterparty_vat_id_required",
    mapping: {
      vatReturnLines: ["40"], controlStatementSection: "B.3",
      vatReturnUnknownReason: null, controlStatementUnknownReason: null,
    },
  }));
  const readiness = await getReportingPeriodReadiness(company.client, { companyId: company.companyId, period: "2026-10" });
  expect(readiness.ok && readiness.value.ready).toBe(false);
  expect(readiness.ok && readiness.value.blockers).toContainEqual({ code: "error_finding", documentId: created.value.id, findingCode: "counterparty_vat_id_required" });
  const exported = await exportReportingPeriodWorkbook(company.client, { companyId: company.companyId, period: "2026-10" });
  if (!exported.ok) throw new Error(exported.error);
  const workbook = XLSX.read(exported.value.bytes, { type: "array" });
  const [row] = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Attention, { defval: "" });
  expect(row).toEqual(expect.objectContaining({
    "Live inclusion": "excluded", "Exclusion reason": "incomplete_data", "Exclusion detail": "counterparty_vat_id_required",
    "Mapping status": "proposed", "VAT Return line": "40", "Control Statement section": "B.3",
  }));
});

it("keeps known Return mapping for a partial schema2 manual draft while explaining its unknown Control Statement threshold", async () => {
  const company = await administratorWithCompany();
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload: {
    ...SYNTHETIC_EXCLUDED_PURCHASE, schemaVersion: 2,
    rateBreakdown: [{ rate: 21, netAmount: "100.00", vatAmount: null }],
    totals: { netAmount: "100.00", vatAmount: null, grossAmount: null },
  } });
  if (!created.ok) throw new Error(created.error);
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  expect(document.reporting).toEqual(expect.objectContaining({
    included: false, exclusionReason: "not_approved",
    mapping: { vatReturnLines: ["40"], controlStatementSection: null, vatReturnUnknownReason: null, controlStatementUnknownReason: "missing_gross_amount" },
  }));
});

it("keeps an Approved Document with only a bank advisory included even when it also appears on Attention", async () => {
  const company = await administratorWithCompany();
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload: {
    ...SYNTHETIC_EXCLUDED_PURCHASE, documentNumber: "SYNTHETIC-INCLUDED-ADVISORY",
    supplier: { ...SYNTHETIC_EXCLUDED_PURCHASE.supplier, vatId: "CZ27082440" },
  } }, undefined, { async check() { return { outcome: "checked", unreliable: false, publishedAccounts: [] }; } });
  if (!created.ok) throw new Error(created.error);
  expect(await approveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, version: 1 })).toEqual({ ok: true, value: null });
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  expect(document.reporting.included).toBe(true);
  expect(document.reporting.blockingFindings).toEqual([]);
  expect(document.reporting.advisoryFindings).toEqual([{ field: "payment.bankAccount", severity: "warning", code: "missing_bank_account" }]);
  const readiness = await getReportingPeriodReadiness(company.client, { companyId: company.companyId, period: "2026-10" });
  expect(readiness.ok && readiness.value.ready).toBe(true);
  const exported = await exportReportingPeriodWorkbook(company.client, { companyId: company.companyId, period: "2026-10" });
  if (!exported.ok) throw new Error(exported.error);
  const workbook = XLSX.read(exported.value.bytes, { type: "array" });
  for (const sheet of ["Included", "Attention"]) {
    const [row] = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheet], { defval: "" });
    expect(row).toEqual(expect.objectContaining({
      "Live inclusion": "included", "Exclusion reason": "", "Mapping status": "included",
      "VAT Return line": "40", "Control Statement section": "B.3", "Blocking findings": "",
      "Advisory findings": "warning: missing_bank_account (payment.bankAccount)",
    }));
  }
});

it("preserves intentional other-regime exclusion as an advisory rather than inventing a completeness blocker", async () => {
  const company = await administratorWithCompany();
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload: {
    ...SYNTHETIC_EXCLUDED_PURCHASE, documentNumber: "SYNTHETIC-OTHER", proposedVatRegime: "other",
  } });
  if (!created.ok) throw new Error(created.error);
  expect(await approveDocument(company.client, { companyId: company.companyId, documentId: created.value.id, version: 1 })).toEqual({ ok: true, value: null });
  const [document] = await listCompanyDocuments(company.client, company.companyId);
  expect(document.reporting).toEqual(expect.objectContaining({
    included: false, exclusionReason: "manual_classification_required", blockingFindings: [],
    mapping: { vatReturnLines: [], controlStatementSection: null, vatReturnUnknownReason: "unsupported_regime", controlStatementUnknownReason: "unsupported_regime" },
  }));
  const readiness = await getReportingPeriodReadiness(company.client, { companyId: company.companyId, period: "2026-10" });
  expect(readiness.ok && readiness.value.ready).toBe(true);
});

it("refuses cached-zero Finalization and a concurrent live correction without rewriting the saved report or archived XML", async () => {
  const company = await administratorWithCompany();
  const period = { companyId: company.companyId, period: "2026-10" };
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload: SYNTHETIC_EXCLUDED_PURCHASE });
  if (!created.ok) throw new Error(created.error);
  await setLegacyDocumentApprovedFixture(inject("databaseUrl"), created.value.id, [{ field: "payment.bankAccount", severity: "warning", code: "missing_bank_account" }]);
  expect((await generateVatReport(company.client, period)).ok).toBe(true);
  await setLegacyReadinessCountFixture(inject("databaseUrl"), company.companyId, period.period);
  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId, taxOffice: "451", territorialOffice: "2003", economicActivity: "621000",
    signatoryFirstName: "Test", signatoryLastName: "Reviewer", signatoryCapacity: "jednatel",
    email: "synthetic@example.test", phone: "+420123456789", epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });
  const archived = await exportVatReport(company.client, { ...period, format: "dphkh1", details: { preparedOn: "2026-10-27" } });
  if (!archived.ok) throw new Error(archived.error);
  const hash = createHash("sha256").update(archived.value.bytes).digest("hex");
  const saved = await getVatReport(company.client, company.companyId, period.period);
  expect(saved?.finalization.blockerCount).toBe(0);
  const current = await getReportingPeriodReadiness(company.client, period);
  expect(current.ok && current.value.snapshot?.freshness).toBe("current");
  expect(current.ok && current.value.ready).toBe(false);
  expect(await finalizeVatReport(company.client, { ...period, confirmed: true })).toEqual({ ok: false, error: "readiness_blocked" });
  const [finalized, returned] = await Promise.all([
    finalizeVatReport(company.client, { ...period, confirmed: true }),
    returnDocumentToReview(company.client, { companyId: company.companyId, documentId: created.value.id }),
  ]);
  expect(finalized.ok).toBe(false);
  expect(!finalized.ok && ["readiness_blocked", "stale_report"].includes(finalized.error)).toBe(true);
  expect(returned).toEqual({ ok: true, value: null });
  expect(await getPeriodLock(company.client, company.companyId, period.period)).toBeNull();
  const stale = await getReportingPeriodReadiness(company.client, period);
  expect(stale.ok && stale.value.snapshot?.freshness).toBe("stale");
  expect(await getVatReport(company.client, company.companyId, period.period)).toEqual(saved);
  const retained = await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: archived.value.artifactId });
  expect(retained?.bytes).toEqual(archived.value.bytes);
  expect(retained?.artifact.sha256).toBe(hash);
});

it("combines unresolved Source and current Document blockers, then resolves them independently before Finalization", async () => {
  const company = await administratorWithCompany();
  const uploaded = await uploadSourceFile(company.client, { async send() {} }, {
    companyId: company.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png"),
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const sourceInput = { companyId: company.companyId, sourceFileId: uploaded.value.id };
  const source = await getSourceFile(company.client, company.companyId, uploaded.value.id);
  if (!source) throw new Error("Source fixture missing");
  const date = pragueDate(source.uploadedAt);
  const period = { companyId: company.companyId, period: date.slice(0, 7) };
  expect((await setCurrentReportingYear(company.client, { companyId: company.companyId, filingFrequency: "monthly", year: Number(date.slice(0, 4)) })).ok).toBe(true);
  const payload = { ...SYNTHETIC_EXCLUDED_PURCHASE, taxPointDate: date };
  const document = await createManualDocument(company.client, { companyId: company.companyId, payload });
  if (!document.ok) throw new Error(document.error);
  await setLegacyDocumentApprovedFixture(inject("databaseUrl"), document.value.id, [
    { field: "payment.bankAccount", severity: "warning", code: "missing_bank_account" },
  ]);
  const documentInput = { companyId: company.companyId, documentId: document.value.id };
  const initial = await getReportingPeriodReadiness(company.client, period);
  if (!initial.ok) throw new Error(initial.error);
  expect(initial.value.sourceFiles).toEqual([expect.objectContaining({ sourceFileId: uploaded.value.id, status: "uploaded" })]);
  expect(initial.value.blockers).toContainEqual({ code: "error_finding", documentId: document.value.id, findingCode: "counterparty_vat_id_required" });
  expect(initial.value.documentReporting[document.value.id].included).toBe(false);
  expect((await listCompanyDocuments(company.client, company.companyId)).map(row => row.id)).toEqual([document.value.id]);
  expect((await generateVatReport(company.client, period)).ok).toBe(true);
  expect((await getVatReport(company.client, company.companyId, period.period))?.finalization.blockerCount).toBe(2);

  expect(await excludeSourceFile(company.client, { ...sourceInput, reason: "Synthetic non-accounting source" })).toEqual({ ok: true, value: null });
  const sourceResolved = await getReportingPeriodReadiness(company.client, period);
  if (!sourceResolved.ok) throw new Error(sourceResolved.error);
  expect(sourceResolved.value.ready).toBe(false);
  expect(sourceResolved.value.sourceFiles).toEqual([expect.objectContaining({ sourceFileId: uploaded.value.id, status: "rejected" })]);
  expect(sourceResolved.value.groups.rejected).toEqual([]);
  expect(sourceResolved.value.snapshot?.freshness).toBe("stale");
  expect((await generateVatReport(company.client, period)).ok).toBe(true);
  expect((await getVatReport(company.client, company.companyId, period.period))?.finalization.blockerCount).toBe(1);
  expect(await finalizeVatReport(company.client, { ...period, confirmed: true })).toEqual({ ok: false, error: "readiness_blocked" });

  expect(await returnDocumentToReview(company.client, documentInput)).toEqual({ ok: true, value: null });
  expect(await correctDocument(company.client, {
    ...documentInput, basedOnVersion: 1, payload: { ...payload, supplier: { ...payload.supplier, vatId: "CZ27082440" } },
  }, undefined, { async check() { return { outcome: "checked", unreliable: false, publishedAccounts: [] }; } })).toEqual({ ok: true, value: { version: 2 } });
  expect(await approveDocument(company.client, { ...documentInput, version: 2 })).toEqual({ ok: true, value: null });
  const complete = await getReportingPeriodReadiness(company.client, period);
  if (!complete.ok) throw new Error(complete.error);
  expect(complete.value.ready).toBe(true);
  expect(complete.value.blockers).toEqual([]);
  expect(complete.value.documentReporting[document.value.id].included).toBe(true);
  expect((await generateVatReport(company.client, period)).ok).toBe(true);
  expect((await getVatReport(company.client, company.companyId, period.period))?.finalization.blockerCount).toBe(0);
  expect(await finalizeVatReport(company.client, { ...period, confirmed: true })).toEqual({ ok: true, value: null });
  expect(await restoreSourceFile(company.client, sourceInput)).toEqual({ ok: false, error: "period_locked" });
  expect(await returnDocumentToReview(company.client, documentInput)).toEqual({ ok: false, error: "period_locked" });
});
