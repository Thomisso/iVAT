// Public seams: AppClient command plus public reads under the same real User.
import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import {
  createManualDocument,
  getDocument,
  listCompanyDocuments,
  updateDocumentReporting,
  approveDocument,
  correctDocument,
  listExtractionVersions,
  saveAndApproveDocument,
  returnDocumentToReview,
  listDocuments,
  listDeferredClaimPeriods,
} from "@/application/documents";
import { fakeExchangeRates } from "@/cnb/fake";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { getDocumentReview } from "@/application/document-review";
import { generateVatReport, getVatReport, finalizeVatReport } from "@/application/vat-reports";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { provisionedUser } from "./support/clients";
import { inject } from "vitest";
import { Client as DatabaseClient } from "pg";
import { uploadSourceFile } from "@/application/source-files";
import { fakeAiProvider } from "@/ai/fake";
import { testWorker } from "./support/worker";
import { assignAiConfigurationFixture } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { changeReportingYearFrequency } from "@/application/reporting-years";
import { setLegacyDocumentApprovedFixture } from "./support/legacy-document-approval";

async function sourceDocument(instant: string, taxPointDate: string, issueDate: string, quarterly = false) {
  const user = await administratorWithCompany();
  if (quarterly) expect(await changeReportingYearFrequency(user.client, { companyId: user.companyId, year: 2026, frequency: "quarterly" })).toEqual({ ok: true, value: null });
  const worker = testWorker(fakeAiProvider({ extract: () => ({ ...SAMPLE_EXTRACTION, taxPointDate, issueDate,
    // A provider cannot assert a human confirmation, even when it fabricates one.
    claimEligibility: { period: "2026-01", origin: "user", confirmed: true },
  }) }));
  await assignAiConfigurationFixture(user.client, worker.jobs, { companyId: user.companyId, provider: worker.ai });
  const uploaded = await uploadSourceFile(user.client, worker.jobs, { companyId: user.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  try { await database.query("update public.source_file set uploaded_at = $2 where id = $1", [uploaded.value.id, instant]); }
  finally { await database.end(); }
  await worker.runJobs();
  const [document] = await listDocuments(user.client, user.companyId, uploaded.value.id);
  return { ...user, document, versions: await listExtractionVersions(user.client, user.companyId, document.id) };
}

it.each(["application", "database"] as const)("blocks unresolved domestic document type at the %s approval boundary", async boundary => {
  const user = await administratorWithCompany();
  const created = await createManualDocument(user.client, { companyId: user.companyId,
    payload: { ...SAMPLE_EXTRACTION, documentType: null },
  }, fakeExchangeRates(), fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: user.companyId, documentId: created.value.id };
  if (boundary === "application") expect(await approveDocument(user.client, { ...input, version: 1 }))
    .toEqual({ ok: false, error: "claim_document_type_required" });
  else expect((await user.client.rpc("approve_document", { target_document_id: input.documentId, reviewed_version: 1 })).error)
    .toMatchObject({ code: "P0001", hint: "claim_document_type_required" });
  expect(await getDocument(user.client, user.companyId, input.documentId)).toMatchObject({ status: "needs_review", importDate: null });
  expect((await getDocumentReview(user.client, input))?.shownFindings)
    .toContainEqual({ field: "documentType", severity: "error", code: "claim_document_type_required" });
});

it.each(["application", "database"] as const)("blocks legacy null-type deduction at the %s preparation boundary without rewriting history", async boundary => {
  const user = await administratorWithCompany();
  const created = await createManualDocument(user.client, { companyId: user.companyId,
    payload: { ...SAMPLE_EXTRACTION, documentType: null },
  }, fakeExchangeRates(), fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  await setLegacyDocumentApprovedFixture(inject("databaseUrl"), created.value.id);
  const before = await listExtractionVersions(user.client, user.companyId, created.value.id);
  if (boundary === "application") expect(await generateVatReport(user.client, { companyId: user.companyId, period: "2026-10" }))
    .toEqual({ ok: false, error: "claim_eligibility_unresolved" });
  else expect((await user.client.rpc("save_vat_report", { target_company_id: user.companyId, target_period: "2026-10",
    expected_documents: [], computed_result: {},
  })).error).toMatchObject({ code: "P0001", hint: "claim_eligibility_unresolved" });
  expect(await listExtractionVersions(user.client, user.companyId, created.value.id)).toEqual(before);
});

it("clearing a confirmed ordinary type cannot bypass atomic approval and remains a valid draft", async () => {
  const user = await administratorWithCompany();
  const created = await createManualDocument(user.client, { companyId: user.companyId, payload: { ...SAMPLE_EXTRACTION,
    claimEligibility: { period: "2026-10", origin: "user", confirmed: true },
  } }, fakeExchangeRates(), fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: user.companyId, documentId: created.value.id };
  const [original] = await listExtractionVersions(user.client, input.companyId, input.documentId);
  const cleared = { ...original.payload, documentType: null };
  expect(await saveAndApproveDocument(user.client, { ...input, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: cleared }, fakeExchangeRates(), fakeVatPayerRegistry()))
    .toMatchObject({ ok: false, error: "claim_document_type_required" });
  expect(await listExtractionVersions(user.client, input.companyId, input.documentId)).toEqual([original]);
  expect(await correctDocument(user.client, { ...input, basedOnVersion: 1, payload: cleared }, fakeExchangeRates(), fakeVatPayerRegistry()))
    .toMatchObject({ ok: true, value: { version: 2 } });
  const history = await listExtractionVersions(user.client, input.companyId, input.documentId);
  expect(history[0]).toEqual(original);
  expect(history[1].payload).toMatchObject({ documentType: null, claimEligibility: { confirmed: false } });
  expect(await approveDocument(user.client, { ...input, version: 2 })).toEqual({ ok: false, error: "claim_document_type_required" });
});

it("resolves a null-type draft only after classification and explicit temporal confirmation", async () => {
  const user = await administratorWithCompany();
  const created = await createManualDocument(user.client, { companyId: user.companyId, payload: { ...SAMPLE_EXTRACTION, documentType: null } }, fakeExchangeRates(), fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: user.companyId, documentId: created.value.id, basedOnVersion: 1 };
  expect(await saveAndApproveDocument(user.client, { ...input, requestId: crypto.randomUUID(), payload: SAMPLE_EXTRACTION }, fakeExchangeRates(), fakeVatPayerRegistry()))
    .toMatchObject({ ok: false, error: "claim_eligibility_required" });
  expect(await saveAndApproveDocument(user.client, { ...input, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION,
    claimEligibility: { period: "2026-10", origin: "user", confirmed: true },
  } }, fakeExchangeRates(), fakeVatPayerRegistry())).toMatchObject({ ok: true, value: { version: 2 } });
});

it("refuses a shared Deferred Claim for an incoming domestic reverse-charge Document", async () => {
  const administrator = await administratorWithCompany();
  const user = await companyMember(administrator);
  const created = await createManualDocument(user.client, {
    companyId: administrator.companyId,
    payload: {
      ...SAMPLE_EXTRACTION,
      documentType: "invoice",
      direction: "incoming",
      issueDate: "2026-10-01",
      taxPointDate: "2026-10-01",
      proposedVatRegime: "domestic_reverse_charge",
      reverseChargeCode: "4",
      rateBreakdown: [{ rate: 21, netAmount: "1000.00", vatAmount: "0.00" }],
      totals: { netAmount: "1000.00", vatAmount: "0.00", grossAmount: "1000.00" },
    },
  }, fakeExchangeRates(), fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);

  expect(await updateDocumentReporting(user.client, {
    companyId: administrator.companyId,
    documentId: created.value.id,
    claimedReportingPeriod: "2026-12",
  })).toEqual({ ok: false, error: "deferred_claim_not_supported" });

  expect(await getDocument(user.client, administrator.companyId, created.value.id))
    .toMatchObject({ claimedReportingPeriod: null, importDate: null, status: "needs_review" });
  expect(await listCompanyDocuments(user.client, administrator.companyId))
    .toMatchObject([{ id: created.value.id, claimedReportingPeriod: null, reportingPeriod: "2026-10" }]);
});

it("records a human Earliest Claim Period without inventing an Import Date and retains it in history", async () => {
  const user = await administratorWithCompany();
  const created = await createManualDocument(user.client, { companyId: user.companyId, payload: SAMPLE_EXTRACTION }, fakeExchangeRates(), fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: user.companyId, documentId: created.value.id };
  const corrected = await correctDocument(user.client, { ...input, basedOnVersion: 1, payload: { ...SAMPLE_EXTRACTION,
    claimEligibility: { period: "2026-10", origin: "user", confirmed: true },
  } }, fakeExchangeRates(), fakeVatPayerRegistry());
  expect(corrected).toMatchObject({ ok: true, value: { version: 2 } });
  expect(await approveDocument(user.client, { ...input, version: 2 })).toEqual({ ok: true, value: null });
  const versions = await listExtractionVersions(user.client, user.companyId, created.value.id);
  expect(versions[0].payload.claimEligibility).toBeUndefined();
  expect(versions[1].payload.claimEligibility).toMatchObject({ period: "2026-10", origin: "user", confirmed: true, basis: { importDate: null, taxPointDate: "2026-10-01" } });
  expect(await getDocument(user.client, user.companyId, created.value.id)).toMatchObject({ importDate: null, status: "approved" });
});

it("refuses a chosen claim period before the confirmed earliest period, including direct RPC", async () => {
  const user = await administratorWithCompany();
  const created = await createManualDocument(user.client, { companyId: user.companyId, payload: { ...SAMPLE_EXTRACTION,
    claimEligibility: { period: "2026-12", origin: "user", confirmed: true },
  } }, fakeExchangeRates(), fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: user.companyId, documentId: created.value.id };
  expect(await updateDocumentReporting(user.client, { ...input, claimedReportingPeriod: "2026-11" })).toEqual({ ok: false, error: "claimed_period_before_earliest" });
  expect((await user.client.rpc("update_document_reporting", { target_document_id: created.value.id, new_claimed_reporting_period: "2026-11" })).error)
    .toMatchObject({ code: "P0001", hint: "claimed_period_before_earliest" });
  expect(await updateDocumentReporting(user.client, { ...input, claimedReportingPeriod: "2026-12" })).toEqual({ ok: true, value: null });
  const outsider = await provisionedUser();
  expect(await getDocument(outsider.client, user.companyId, created.value.id)).toBeNull();
  expect(await updateDocumentReporting(outsider.client, { ...input, claimedReportingPeriod: "2026-12" })).toEqual({ ok: false, error: "forbidden" });
  expect((await outsider.client.rpc("reporting_period_claim_issues", { target_company_id: user.companyId, target_period: "2026-12" })).error)
    .toMatchObject({ code: "42501" });
});

it("requires manual resolution of legacy RC deferral before preparing either affected period", async () => {
  const user = await administratorWithCompany();
  const created = await createManualDocument(user.client, { companyId: user.companyId, payload: { ...SAMPLE_EXTRACTION,
    proposedVatRegime: "domestic_reverse_charge", reverseChargeCode: "4",
  } }, fakeExchangeRates(), fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    // Deliberate predecessor fixture, not an application bypass.
    await database.query("begin");
    await database.query("set local session_replication_role = replica");
    await database.query("update public.document set claimed_reporting_period = '2026-12', status = 'approved' where id = $1", [created.value.id]);
    await database.query("commit");
  } finally { await database.end(); }
  for (const period of ["2026-10", "2026-12"]) {
    expect(await generateVatReport(user.client, { companyId: user.companyId, period }))
      .toEqual({ ok: false, error: "claim_eligibility_unresolved" });
    const readiness = await getReportingPeriodReadiness(user.client, { companyId: user.companyId, period });
    expect(readiness).toMatchObject({ ok: true, value: { ready: false, blockers: [{ documentId: created.value.id, findingCode: "deferred_claim_not_supported" }] } });
  }
  expect((await user.client.rpc("save_vat_report", { target_company_id: user.companyId, target_period: "2026-10", expected_documents: [], computed_result: {} })).error)
    .toMatchObject({ code: "P0001", hint: "claim_eligibility_unresolved" });
  expect(await getDocument(user.client, user.companyId, created.value.id)).toMatchObject({ claimedReportingPeriod: "2026-12", status: "approved" });
  expect(await returnDocumentToReview(user.client, { companyId: user.companyId, documentId: created.value.id })).toEqual({ ok: true, value: null });
  expect(await updateDocumentReporting(user.client, { companyId: user.companyId, documentId: created.value.id, claimedReportingPeriod: null })).toEqual({ ok: true, value: null });
  expect(await approveDocument(user.client, { companyId: user.companyId, documentId: created.value.id, version: 1 })).toEqual({ ok: true, value: null });
  expect(await generateVatReport(user.client, { companyId: user.companyId, period: "2026-10" })).toMatchObject({ ok: true });
});

it.each(["domestic_reverse_charge", "eu_acquisition_of_goods", "eu_received_service"] as const)("refuses direct shared %s deferral and offers no selectable deferral", async proposedVatRegime => {
  const user = await administratorWithCompany();
  const created = await createManualDocument(user.client, { companyId: user.companyId, payload: { ...SAMPLE_EXTRACTION, proposedVatRegime, reverseChargeCode: "4" } }, fakeExchangeRates(), fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  expect((await user.client.rpc("update_document_reporting", { target_document_id: created.value.id, new_claimed_reporting_period: "2026-12" })).error)
    .toMatchObject({ code: "P0001", hint: "deferred_claim_not_supported" });
  expect(await listDeferredClaimPeriods(user.client, user.companyId, created.value.id)).toEqual([]);
});

it("makes changed source facts stale without rewriting the saved report and protects locked accounting data", async () => {
  const user = await sourceDocument("2026-10-10T10:00:00Z", "2026-10-01", "2026-10-01");
  const input = { companyId: user.companyId, documentId: user.document.id };
  expect(await approveDocument(user.client, { ...input, version: 1 })).toEqual({ ok: true, value: null });
  expect(await generateVatReport(user.client, { companyId: user.companyId, period: "2026-10" })).toMatchObject({ ok: true });
  const saved = await getVatReport(user.client, user.companyId, "2026-10");
  expect(saved?.documents[0].payload?.claimEligibility).toMatchObject({ origin: "same_period", period: "2026-10" });
  expect(await finalizeVatReport(user.client, { companyId: user.companyId, period: "2026-10", confirmed: true })).toEqual({ ok: true, value: null });
  expect(await updateDocumentReporting(user.client, { ...input, claimedReportingPeriod: "2026-12" })).toEqual({ ok: false, error: "period_locked" });
  expect(await returnDocumentToReview(user.client, input)).toEqual({ ok: false, error: "period_locked" });
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  try { await database.query("update public.source_file set uploaded_at = '2026-11-10T10:00:00Z' where id = $1", [user.document.sourceFileId]); }
  finally { await database.end(); }
  expect(await getReportingPeriodReadiness(user.client, { companyId: user.companyId, period: "2026-10" }))
    .toMatchObject({ ok: true, value: { ready: false, snapshot: { freshness: "stale" } } });
  expect(await getVatReport(user.client, user.companyId, "2026-10")).toEqual(saved);
});

it.each([
  ["2026-09-30T21:59:59Z", "2026-10-01", "2026-10-01", "2026-09-30", null, false],
  ["2026-09-30T22:00:00Z", "2026-10-01", "2026-10-01", "2026-10-01", "2026-10", false],
  ["2026-12-31T22:59:59Z", "2026-12-15", "2026-12-15", "2026-12-31", "2026-12", false],
  ["2026-12-31T23:00:00Z", "2026-12-15", "2026-12-15", "2027-01-01", null, false],
  ["2026-03-05T10:00:00Z", "2026-01-10", "2026-01-12", "2026-03-05", null, false],
  ["2026-03-05T10:00:00Z", "2026-01-10", "2026-02-12", "2026-03-05", "2026-Q1", true],
] as const)("uses actual Prague import %s and generated frequency for same-period eligibility", async (instant, taxPointDate, issueDate, importDate, expectedPeriod, quarterly) => {
  const user = await sourceDocument(instant, taxPointDate, issueDate, quarterly);
  expect(user.document.importDate).toBe(importDate);
  if (expectedPeriod) expect(user.versions[0].payload.claimEligibility).toMatchObject({ period: expectedPeriod, origin: "same_period", confirmed: true, basis: { importDate } });
  else expect(user.versions[0].payload.claimEligibility).toBeUndefined();
});

it("submits human eligibility atomically and requires new confirmation after decisive dates change", async () => {
  const user = await administratorWithCompany();
  const created = await createManualDocument(user.client, { companyId: user.companyId, payload: SAMPLE_EXTRACTION }, fakeExchangeRates(), fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: user.companyId, documentId: created.value.id };
  const result = await saveAndApproveDocument(user.client, { ...input, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION,
    claimEligibility: { period: "2026-10", origin: "user", confirmed: true },
  } }, fakeExchangeRates(), fakeVatPayerRegistry());
  expect(result).toMatchObject({ ok: true, value: { version: 2 } });
  const before = (await listExtractionVersions(user.client, user.companyId, created.value.id))[1];
  expect(await returnDocumentToReview(user.client, input)).toEqual({ ok: true, value: null });
  expect(await correctDocument(user.client, { ...input, basedOnVersion: 2, payload: { ...before.payload, issueDate: "2026-11-01" } }, fakeExchangeRates(), fakeVatPayerRegistry()))
    .toMatchObject({ ok: true, value: { version: 3 } });
  const history = await listExtractionVersions(user.client, user.companyId, created.value.id);
  expect(history[1].payload.claimEligibility).toEqual(before.payload.claimEligibility);
  expect(history[2].payload.claimEligibility).toMatchObject({ period: "2026-10", confirmed: false });
  expect(await approveDocument(user.client, { ...input, version: 3 })).toEqual({ ok: false, error: "claim_eligibility_required" });
  expect((await getDocumentReview(user.client, { ...input, requestedVersion: "2" }))?.shown?.payload.claimEligibility).toEqual(before.payload.claimEligibility);
});

it("keeps source-less domestic eligibility unresolved and refuses approval", async () => {
  const user = await administratorWithCompany();
  const created = await createManualDocument(user.client, { companyId: user.companyId, payload: SAMPLE_EXTRACTION }, fakeExchangeRates(), fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  expect(await approveDocument(user.client, { companyId: user.companyId, documentId: created.value.id, version: 1 }))
    .toEqual({ ok: false, error: "claim_eligibility_required" });
  expect(await getDocument(user.client, user.companyId, created.value.id)).toMatchObject({ importDate: null, status: "needs_review" });
  expect((await getDocumentReview(user.client, { companyId: user.companyId, documentId: created.value.id }))?.shownFindings)
    .toContainEqual({ field: "claimEligibility", severity: "error", code: "claim_eligibility_required" });
});
