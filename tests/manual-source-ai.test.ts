import { expect, it } from "vitest";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { approveDocument, reprocessDocument, correctDocument, startManualDocumentReview, readDocumentRows, attachDocumentSource, createManualDocument, getDocument, listDocuments, listExtractionVersions, readDocumentPages, rejectDocument, returnDocumentToReview } from "@/application/documents";
import { getSourceFile, readSourceFile } from "@/application/source-files";
import { getCompanyAiProcessingAllowance, setCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { administratorWithCompany, assignAiConfigurationFixture, companyMember } from "./support/fixtures";
import { fixtureFile, multiSheetWorkbookFile, heicFixture } from "./support/files";
import { testWorker } from "./support/worker";
import { AiProviderError } from "@/application/ai-provider";
import { finalizeVatReport, generateVatReport, getVatReport } from "@/application/vat-reports";
import { promotedSuperAdministrator } from "./support/platform";
import { listAuditEvents } from "@/application/audit";
import { PDFDocument } from "pdf-lib";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { exportVatReport, readVatReportArtifact } from "@/application/epo-export";
import { exportCompanyData } from "@/application/company-deletion";
import { unzipSync } from "fflate";

it("attaches a real original to the same Approved manual Document without changing values, history or successful AI usage", async () => {
  const company = await administratorWithCompany();
  const manual = await createManualDocument(company.client, { companyId: company.companyId, payload: { ...SAMPLE_EXTRACTION, documentNumber: "MANUAL-PRESERVED" } });
  if (!manual.ok) throw new Error(manual.error);
  const input = { companyId: company.companyId, documentId: manual.value.id };
  expect(await approveDocument(company.client, { ...input, version: 1 })).toEqual({ ok: true, value: null });
  const before = await listExtractionVersions(company.client, input.companyId, input.documentId);
  const original = fixtureFile("receipt.png");
  const attached = await attachDocumentSource(company.client, { ...input, fileName: "receipt.png", bytes: original });
  expect(attached).toEqual({ ok: true, value: { sourceFileId: expect.any(String) } });
  if (!attached.ok) throw new Error(attached.error);
  expect(await getDocument(company.client, input.companyId, input.documentId)).toEqual(expect.objectContaining({
    id: input.documentId, status: "approved", sourceFileId: attached.value.sourceFileId, firstPage: 1, lastPage: 1,
  }));
  expect(await listExtractionVersions(company.client, input.companyId, input.documentId)).toEqual(before);
  expect((await readSourceFile(company.client, input.companyId, attached.value.sourceFileId))?.bytes).toEqual(original);
  expect((await getSourceFile(company.client, input.companyId, attached.value.sourceFileId))?.status).toBe("split");
  expect((await listDocuments(company.client, input.companyId, attached.value.sourceFileId)).map(document => document.id)).toEqual([input.documentId]);
  expect(await getCompanyAiProcessingAllowance(company.client, input.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
});

async function manualWithSource(approved = true) {
  const company = await administratorWithCompany();
  const manual = await createManualDocument(company.client, { companyId: company.companyId, payload: { ...SAMPLE_EXTRACTION, documentNumber: "MANUAL-PRESERVED" } });
  if (!manual.ok) throw new Error(manual.error);
  const input = { companyId: company.companyId, documentId: manual.value.id };
  if (approved) await approveDocument(company.client, { ...input, version: 1 });
  const attached = await attachDocumentSource(company.client, { ...input, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!attached.ok) throw new Error(attached.error);
  return { ...company, ...input, sourceFileId: attached.value.sourceFileId };
}

it.each(["xlsx", "xls"] as const)("attaches actual %s rows without inventing a page image or changing the manual Version", async (format) => {
  const context = await administratorWithCompany();
  const manual = await createManualDocument(context.client, { companyId: context.companyId, payload: SAMPLE_EXTRACTION });
  if (!manual.ok) throw new Error(manual.error);
  const input = { companyId: context.companyId, documentId: manual.value.id, fileName: `manual.${format}`, bytes: multiSheetWorkbookFile(format) };
  expect(await attachDocumentSource(context.client, { ...input, range: { sheetName: "Issued", firstRow: 2, lastRow: 4 } })).toEqual({ ok: false, error: "invalid_workbook_ranges" });
  const attached = await attachDocumentSource(context.client, { ...input, range: { sheetName: "Issued", firstRow: 2, lastRow: 3 } });
  expect(attached.ok).toBe(true);
  expect(await readDocumentRows(context.client, input.companyId, input.documentId)).toMatchObject({ sheetName: "Issued", firstRow: 2, lastRow: 3, text: '[Sheet "Issued"]\n1\tDocument number\tGross amount\n2\tISSUED-1\t484\n3\tISSUED-2\t605' });
  expect(await getDocument(context.client, input.companyId, input.documentId)).toMatchObject({ id: input.documentId, hasDocumentImage: false, status: "needs_review" });
  expect((await listExtractionVersions(context.client, input.companyId, input.documentId)).map(v => v.author.kind)).toEqual(["user"]);
});

it("requires explicit confirmation even through the native RPC, then refuses unusable AI before withdrawing approval", async () => {
  const context = await manualWithSource(); const worker = testWorker();
  const before = await listExtractionVersions(context.client, context.companyId, context.documentId);
  expect(await reprocessDocument(context.client, worker.jobs, context)).toEqual({ ok: false, error: "confirmation_required" });
  expect((await context.client.rpc("reprocess_document", { target_document_id: context.documentId })).error?.hint).toBe("confirmation_required");
  expect(await reprocessDocument(context.client, worker.jobs, { ...context, confirmed: true })).toEqual({ ok: false, error: "ai_configuration_unavailable" });
  expect((await getDocument(context.client, context.companyId, context.documentId))?.status).toBe("approved");
  expect(await listExtractionVersions(context.client, context.companyId, context.documentId)).toEqual(before);
  expect(worker.queued).toEqual([]);
});

it("a Company User confirmed AI replaces the current values with a new immutable AI Version needing human review and consumes one successful allowance", async () => {
  const context = await manualWithSource();
  const user = await companyMember(context);
  const worker = testWorker(fakeAiProvider({ extract: () => ({ ...SAMPLE_EXTRACTION, documentNumber: "AI-REPLACEMENT" }) }));
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  const before = await listExtractionVersions(context.client, context.companyId, context.documentId);
  expect(await reprocessDocument(user.client, worker.jobs, { ...context, confirmed: true })).toEqual({ ok: true, value: null });
  expect((await getDocument(context.client, context.companyId, context.documentId))?.status).toBe("uploaded");
  worker.queued.push(...worker.queued);
  expect(await worker.runJobsConcurrently()).toEqual([]);
  expect((await getDocument(context.client, context.companyId, context.documentId))?.status).toBe("needs_review");
  const after = await listExtractionVersions(context.client, context.companyId, context.documentId);
  expect(after.slice(0, 1)).toEqual(before);
  expect(after.map(v => [v.version, v.author.kind, v.payload.documentNumber])).toEqual([[1, "user", "MANUAL-PRESERVED"], [2, "ai", "AI-REPLACEMENT"]]);
  expect(await getCompanyAiProcessingAllowance(context.client, context.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
  expect(await approveDocument(user.client, { ...context, version: 2 })).toEqual({ ok: true, value: null });
  expect(await saveCompanyFilingDefaults(context.client, {
    companyId: context.companyId, taxOffice: "451", territorialOffice: "2003", economicActivity: "621000",
    signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
    email: "podatelna@example.test", phone: "+420123456789", epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });
  const period = { companyId: context.companyId, period: "2026-10" };
  expect((await generateVatReport(user.client, period)).ok).toBe(true);
  const snapshot = await getVatReport(user.client, period.companyId, period.period);
  const included = await getReportingPeriodReadiness(user.client, period);
  if (!included.ok) throw new Error(included.error);
  expect(included.value.documentReporting[context.documentId].included).toBe(true);
  expect(included.value.snapshot?.freshness).toBe("current");
  const archived = await exportVatReport(user.client, { ...period, format: "dphdp3", details: { preparedOn: "2026-10-29" } });
  if (!archived.ok) throw new Error(archived.error);
  expect(await returnDocumentToReview(user.client, context)).toEqual({ ok: true, value: null });
  expect(await rejectDocument(user.client, { ...context, reason: "Excluded after human review of the AI replacement" })).toEqual({ ok: true, value: null });
  const excluded = await getReportingPeriodReadiness(user.client, period);
  if (!excluded.ok) throw new Error(excluded.error);
  expect(excluded.value.documentReporting[context.documentId].included).toBe(false);
  expect(excluded.value.snapshot?.freshness).toBe("stale");
  expect(excluded.value.ready).toBe(true);
  expect(await getVatReport(user.client, period.companyId, period.period)).toEqual(snapshot);
  expect((await generateVatReport(user.client, period)).ok).toBe(true);
  expect((await getVatReport(user.client, period.companyId, period.period))?.finalization.rejectedDocumentCount).toBe(1);
  expect(await listExtractionVersions(user.client, context.companyId, context.documentId)).toEqual(after);
  expect((await readSourceFile(user.client, context.companyId, context.sourceFileId))?.bytes).toEqual(fixtureFile("receipt.png"));
  expect((await readVatReportArtifact(user.client, { companyId: context.companyId, artifactId: archived.value.artifactId }))?.bytes).toEqual(archived.value.bytes);
  const exported = await exportCompanyData(context.client, worker.jobs, { companyId: context.companyId });
  if (!exported.ok) throw new Error(exported.error);
  const archive = unzipSync(exported.value.bytes);
  expect(archive[`vat-report-artifacts/${archived.value.artifactId}/${archived.value.fileName}`]).toEqual(archived.value.bytes);
  expect(archive[`source-files/${context.sourceFileId}/receipt.png`]).toEqual(fixtureFile("receipt.png"));
  expect(await getCompanyAiProcessingAllowance(context.client, context.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
});



it("validates actual PDF bounds before storing, retains the full original and exposes only its selected pages", async () => {
  const context = await administratorWithCompany(); const user = await companyMember(context);
  const manual = await createManualDocument(user.client, { companyId: context.companyId, payload: SAMPLE_EXTRACTION });
  if (!manual.ok) throw new Error(manual.error);
  const sourceFileId = crypto.randomUUID();
  const input = { companyId: context.companyId, documentId: manual.value.id, sourceFileId, fileName: "two-invoices.pdf", bytes: fixtureFile("two-invoices.pdf") };
  expect(await attachDocumentSource(user.client, { ...input, range: { firstPage: 2, lastPage: 3 } })).toEqual({ ok: false, error: "invalid_source_range" });
  expect(await readSourceFile(user.client, input.companyId, sourceFileId)).toBeNull();
  const attached = await attachDocumentSource(user.client, { ...input, range: { firstPage: 2, lastPage: 2 } });
  expect(attached).toEqual({ ok: true, value: { sourceFileId } });
  expect(await attachDocumentSource(user.client, { ...input, range: { firstPage: 2, lastPage: 2 } })).toEqual(attached);
  expect(await attachDocumentSource(user.client, { ...input, range: { firstPage: 1, lastPage: 2 } })).toEqual({ ok: false, error: "invalid_choice" });
  expect((await readSourceFile(user.client, input.companyId, sourceFileId))?.bytes).toEqual(input.bytes);
  const pages = await readDocumentPages(user.client, input.companyId, input.documentId);
  expect((await PDFDocument.load(pages!.bytes)).getPageCount()).toBe(1);
  expect((await listDocuments(user.client, input.companyId, sourceFileId)).map(doc => doc.id)).toEqual([input.documentId]);
  expect((await listAuditEvents(context.client, context.organizationId)).filter(event => event.action === "document.source_attached")).toMatchObject([{ actorUserId: user.userId, targetId: input.documentId, payload: { source_file_id: sourceFileId, range: { firstPage: 2, lastPage: 2 } } }]);
});

it("serializes concurrent attachment attempts and forbids a foreign actor before any evidence is stored", async () => {
  const context = await administratorWithCompany(); const foreign = await administratorWithCompany();
  const manual = await createManualDocument(context.client, { companyId: context.companyId, payload: SAMPLE_EXTRACTION });
  if (!manual.ok) throw new Error(manual.error);
  const input = { companyId: context.companyId, documentId: manual.value.id, sourceFileId: crypto.randomUUID(), fileName: "receipt.png", bytes: fixtureFile("receipt.png") };
  expect(await attachDocumentSource(foreign.client, input)).toEqual({ ok: false, error: "forbidden" });
  expect((await foreign.client.rpc("attach_document_source", { target_company_id: input.companyId, target_document_id: input.documentId, target_source_file_id: input.sourceFileId, source_metadata: {}, source_range: {} })).error?.code).toBe("42501");
  expect((await getDocument(context.client, input.companyId, input.documentId))?.sourceFileId).toBeNull();
  const results = await Promise.all([attachDocumentSource(context.client, input), attachDocumentSource(context.client, { ...input, sourceFileId: crypto.randomUUID() })]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.filter(result => !result.ok)).toEqual([{ ok: false, error: "source_already_attached" }]);
});

it("refuses attachment and confirmed replacement under a Period Lock and preserves the archived report", async () => {
  const context = await manualWithSource();
  const manual = await createManualDocument(context.client, { companyId: context.companyId, payload: { ...SAMPLE_EXTRACTION, documentNumber: "UNATTACHED" } });
  if (!manual.ok) throw new Error(manual.error);
  await approveDocument(context.client, { companyId: context.companyId, documentId: manual.value.id, version: 1 });
  const period = { companyId: context.companyId, period: "2026-10" };
  expect((await generateVatReport(context.client, period)).ok).toBe(true);
  expect(await finalizeVatReport(context.client, { ...period, confirmed: true })).toEqual({ ok: true, value: null });
  const before = await getVatReport(context.client, period.companyId, period.period);
  expect(await attachDocumentSource(context.client, { companyId: context.companyId, documentId: manual.value.id, fileName: "receipt.png", bytes: fixtureFile("receipt.png") })).toEqual({ ok: false, error: "period_locked" });
  expect(await reprocessDocument(context.client, testWorker().jobs, { ...context, confirmed: true })).toEqual({ ok: false, error: "period_locked" });
  expect(await getVatReport(context.client, period.companyId, period.period)).toEqual(before);
});

it("refuses exhausted successful allowance before withdrawing approval", async () => {
  const context = await manualWithSource(); const worker = testWorker();
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  const operator = await promotedSuperAdministrator("Manual AI allowance", "manual-source-ai");
  expect(await setCompanyAiProcessingAllowance(operator.client, worker.jobs, { companyId: context.companyId, allowance: 0 })).toEqual({ ok: true, value: null });
  expect(await reprocessDocument(context.client, worker.jobs, { ...context, confirmed: true })).toEqual({ ok: false, error: "allowance_exhausted" });
  expect((await getDocument(context.client, context.companyId, context.documentId))?.status).toBe("approved");
  expect(worker.queued).toEqual([]);
});

it.each([false, true])("provider failure (platform intervention %s) preserves manual values/history without automatic reapproval or successful allowance", async (platformIntervention) => {
  const context = await manualWithSource(); const worker = testWorker(fakeAiProvider({ extract: () => { throw new AiProviderError("unavailable", "Unavailable", { transient: false, platformIntervention, classification: "provider_unavailable" }); } }));
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  const before = await listExtractionVersions(context.client, context.companyId, context.documentId);
  expect(await reprocessDocument(context.client, worker.jobs, { ...context, confirmed: true })).toEqual({ ok: true, value: null });
  await worker.runJobs();
  expect((await getDocument(context.client, context.companyId, context.documentId))?.status).toBe(platformIntervention ? "waiting_for_platform" : "failed");
  expect(await listExtractionVersions(context.client, context.companyId, context.documentId)).toEqual(before);
  expect(await getCompanyAiProcessingAllowance(context.client, context.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
});

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
it.each(["success", "failure"] as const)("late replacement %s cannot overwrite newer manual work or consume successful allowance", async outcome => {
  const context = await manualWithSource(); const started = gate(); const finish = gate();
  const worker = testWorker(fakeAiProvider({ extract: async () => { started.release(); await finish.promise; if (outcome === "failure") throw new Error("late failure"); return { ...SAMPLE_EXTRACTION, documentNumber: "STALE-AI" }; } }));
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  await reprocessDocument(context.client, worker.jobs, { ...context, confirmed: true });
  const running = worker.runJobsConcurrently(); await started.promise;
  expect(await startManualDocumentReview(context.client, context)).toEqual({ ok: true, value: null });
  expect(await correctDocument(context.client, { ...context, basedOnVersion: 1, payload: { ...SAMPLE_EXTRACTION, documentNumber: "NEW-HUMAN" } })).toEqual({ ok: true, value: { version: 2 } });
  await approveDocument(context.client, { ...context, version: 2 }); finish.release(); await running;
  expect((await getDocument(context.client, context.companyId, context.documentId))?.status).toBe("approved");
  expect((await listExtractionVersions(context.client, context.companyId, context.documentId)).map(v => [v.author.kind, v.payload.documentNumber])).toEqual([["user", "MANUAL-PRESERVED"], ["user", "NEW-HUMAN"]]);
  expect(await getCompanyAiProcessingAllowance(context.client, context.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
});

it.each(["cancelled", "newer-human", "completed"] as const)("a lost queue acknowledgement compensates only its own request (%s)", async outcome => {
  const context = await manualWithSource(); const worker = testWorker();
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  const result = await reprocessDocument(context.client, { async send(job) {
    if (outcome === "newer-human") {
      await startManualDocumentReview(context.client, context);
      await correctDocument(context.client, { ...context, basedOnVersion: 1, payload: { ...SAMPLE_EXTRACTION, documentNumber: "NEWER" } });
      await approveDocument(context.client, { ...context, version: 2 });
    } else if (outcome === "completed") { await worker.jobs.send(job); await worker.runJobs(); }
    throw new Error("Lost acknowledgement");
  } }, { ...context, confirmed: true });
  expect(result).toEqual(outcome === "completed" ? { ok: true, value: null } : { ok: false, error: "processing_dispatch_failed" });
  expect((await getDocument(context.client, context.companyId, context.documentId))?.status).toBe(outcome === "newer-human" ? "approved" : "needs_review");
  expect((await listExtractionVersions(context.client, context.companyId, context.documentId)).map(v => v.author.kind)).toEqual(outcome === "completed" ? ["user", "ai"] : outcome === "newer-human" ? ["user", "user"] : ["user"]);
  expect(await getCompanyAiProcessingAllowance(context.client, context.companyId)).toMatchObject({ ok: true, value: { used: outcome === "completed" ? 1 : 0 } });
});

it("preserves a genuine HEIC original and its existing normalized preview without running AI", async () => {
  const context = await administratorWithCompany();
  const manual = await createManualDocument(context.client, { companyId: context.companyId, payload: SAMPLE_EXTRACTION });
  if (!manual.ok) throw new Error(manual.error);
  const original = heicFixture();
  const attached = await attachDocumentSource(context.client, { companyId: context.companyId, documentId: manual.value.id, fileName: "original.heic", bytes: original });
  if (!attached.ok) throw new Error(attached.error);
  expect((await readSourceFile(context.client, context.companyId, attached.value.sourceFileId))?.bytes).toEqual(original);
  expect(await getSourceFile(context.client, context.companyId, attached.value.sourceFileId)).toMatchObject({ normalizedDerivative: { format: "jpeg" }, status: "split" });
  expect((await listExtractionVersions(context.client, context.companyId, manual.value.id)).map(version => version.author.kind)).toEqual(["user"]);
});

it("a confirmed workbook replacement sends only the actual selected rows and header to Extraction", async () => {
  const context = await administratorWithCompany();
  const created = await createManualDocument(context.client, { companyId: context.companyId, payload: SAMPLE_EXTRACTION });
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: context.companyId, documentId: created.value.id };
  await attachDocumentSource(context.client, { ...input, fileName: "actual.xlsx", bytes: multiSheetWorkbookFile("xlsx"), range: { sheetName: "Issued", firstRow: 3, lastRow: 3 } });
  const worker = testWorker(fakeAiProvider({ split: () => { throw new Error("Attachment must not Split"); }, extract: received => {
    expect(received.text).toBe('[Sheet "Issued"]\n1\tDocument number\tGross amount\n3\tISSUED-2\t605');
    expect(new TextDecoder().decode(received.bytes)).toBe(received.text);
    return SAMPLE_EXTRACTION;
  } }));
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  expect(worker.queued).toEqual([]);
  expect(await reprocessDocument(context.client, worker.jobs, { ...input, confirmed: true })).toEqual({ ok: true, value: null });
  expect(await worker.runJobs()).toEqual([]);
  expect((await listExtractionVersions(context.client, input.companyId, input.documentId)).map(version => version.author.kind)).toEqual(["user", "ai"]);
});

it("a failed old dispatch cannot cancel a newer confirmed retry request", async () => {
  const context = await manualWithSource(); const worker = testWorker();
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  expect(await reprocessDocument(context.client, { async send() {
    await startManualDocumentReview(context.client, context);
    await correctDocument(context.client, { ...context, basedOnVersion: 1, payload: { ...SAMPLE_EXTRACTION, documentNumber: "NEWER" } });
    expect(await reprocessDocument(context.client, worker.jobs, { ...context, confirmed: true })).toEqual({ ok: true, value: null });
    throw new Error("Old acknowledgement failed");
  } }, { ...context, confirmed: true })).toEqual({ ok: false, error: "processing_dispatch_failed" });
  expect((await getDocument(context.client, context.companyId, context.documentId))?.status).toBe("uploaded");
  expect(await worker.runJobs()).toEqual([]);
  expect((await listExtractionVersions(context.client, context.companyId, context.documentId)).map(version => version.author.kind)).toEqual(["user", "user", "ai"]);
});

it("a real SuperAdmin can attach evidence for support without tenant Membership and retains the real audit actor", async () => {
  const context = await administratorWithCompany(); const operator = await promotedSuperAdministrator("Manual Source support", "manual-source-support");
  const created = await createManualDocument(context.client, { companyId: context.companyId, payload: SAMPLE_EXTRACTION });
  if (!created.ok) throw new Error(created.error);
  const attached = await attachDocumentSource(operator.client, { companyId: context.companyId, documentId: created.value.id, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  expect(attached.ok).toBe(true);
  expect((await listAuditEvents(context.client, context.organizationId)).filter(event => event.action === "document.source_attached")).toMatchObject([{ actorUserId: operator.userId, targetId: created.value.id }]);
});

it.each([null, [], { firstPage: 0, lastPage: 1 }, { firstPage: 1, lastPage: 2 }, { firstPage: "1", lastPage: 1 }, { firstPage: 1, lastPage: 1, vatId: "invented" }, { firstPage: 1, lastPage: 9007199254740991 }])("the direct attachment transition refuses malformed or fabricated page boundaries atomically: %j", async range => {
  const context = await administratorWithCompany(); const created = await createManualDocument(context.client, { companyId: context.companyId, payload: SAMPLE_EXTRACTION });
  if (!created.ok) throw new Error(created.error);
  const refused = await context.client.rpc("attach_document_source", { target_company_id: context.companyId, target_document_id: created.value.id, target_source_file_id: crypto.randomUUID(), source_metadata: { fileName: "receipt.png", format: "png", byteSize: 100, pageCount: 1, sha256: "a".repeat(64) }, source_range: range });
  expect(refused.error).toMatchObject({ code: "P0001", hint: "invalid_source_range" });
  expect((await getDocument(context.client, context.companyId, created.value.id))?.sourceFileId).toBeNull();
  expect((await listExtractionVersions(context.client, context.companyId, created.value.id)).map(version => version.author.kind)).toEqual(["user"]);
});

it("one remaining allowance cannot withdraw two manual approvals through concurrent confirmed requests", async () => {
  const context = await manualWithSource(); const worker = testWorker();
  const second = await createManualDocument(context.client, { companyId: context.companyId, payload: { ...SAMPLE_EXTRACTION, documentNumber: "SECOND" } });
  if (!second.ok) throw new Error(second.error);
  const secondInput = { companyId: context.companyId, documentId: second.value.id };
  await approveDocument(context.client, { ...secondInput, version: 1 });
  await attachDocumentSource(context.client, { ...secondInput, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  const operator = await promotedSuperAdministrator("Concurrent manual allowance", "manual-source-capacity");
  await setCompanyAiProcessingAllowance(operator.client, worker.jobs, { companyId: context.companyId, allowance: 1 });
  const results = await Promise.all([reprocessDocument(context.client, worker.jobs, { ...context, confirmed: true }), reprocessDocument(context.client, worker.jobs, { ...secondInput, confirmed: true })]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.filter(result => !result.ok)).toEqual([{ ok: false, error: "allowance_exhausted" }]);
  expect(await worker.runJobs()).toEqual([]);
  const statuses = await Promise.all([context.documentId, secondInput.documentId].map(async id => (await getDocument(context.client, context.companyId, id))?.status));
  expect(statuses.sort()).toEqual(["approved", "needs_review"]);
  expect(await getCompanyAiProcessingAllowance(context.client, context.companyId)).toMatchObject({ ok: true, value: { used: 1, allowance: 1 } });
});

it("a metadata-only direct RPC cannot fabricate an original or attach nonexistent evidence", async () => {
  const context = await administratorWithCompany(); const created = await createManualDocument(context.client, { companyId: context.companyId, payload: SAMPLE_EXTRACTION });
  if (!created.ok) throw new Error(created.error);
  const sourceFileId = crypto.randomUUID();
  const refused = await context.client.rpc("attach_document_source", { target_company_id: context.companyId, target_document_id: created.value.id, target_source_file_id: sourceFileId, source_metadata: { fileName: "invented.png", format: "png", byteSize: 100, pageCount: 1, sha256: "a".repeat(64) }, source_range: { firstPage: 1, lastPage: 1 } });
  expect(refused.error).toMatchObject({ code: "P0001", hint: "invalid_choice" });
  expect(await getSourceFile(context.client, context.companyId, sourceFileId)).toBeNull();
  expect((await getDocument(context.client, context.companyId, created.value.id))?.sourceFileId).toBeNull();
});
