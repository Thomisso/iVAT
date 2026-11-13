import { sourceSplitRequestFixture } from "./support/source-request";
import { promotedSuperAdministrator } from "./support/platform";
import { resumePlatformAiProcessing } from "@/application/ai-configurations";
import { Client as DatabaseClient } from "pg";
import { listAuditEvents } from "@/application/audit";
import { exportCompanyData } from "@/application/company-deletion";
import { unzipSync, strFromU8 } from "fflate";
import { beginUploadBatch, finishUploadBatch, getUploadBatch } from "@/application/upload-batches";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { generateVatReport, finalizeVatReport, getVatReport, getPeriodLock } from "@/application/vat-reports";
import { setCurrentReportingYear } from "@/application/companies";
import { pragueDate } from "@/application/reporting-periods";
import { AiProviderError } from "@/application/ai-provider";
import { expect, inject, it } from "vitest";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { defineSourceDocuments, excludeSourceFile, restoreSourceFile, startManualSourceReview, retrySplit, getSourceFile, readSourceFile } from "@/application/source-files";
import { uploadSourceFile } from "./support/source-upload";
import { approveDocument, correctDocument, listDocuments, listExtractionVersions } from "@/application/documents";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { knownSupplierFixture, administratorWithCompany, companyMember, assignAiConfigurationFixture } from "./support/fixtures";
import { fixtureFile, selectFixtureFiles } from "./support/files";
import { testWorker, systemClient } from "./support/worker";
import { splitJob } from "@/application/processing";

// Explicit human confirmation belongs only to the manual corrections below, never the fake AI.
const REVIEWED_EXTRACTION = { ...SAMPLE_EXTRACTION, claimEligibility: { period: "2026-10", origin: "user" as const, confirmed: true } };

it.each([
  ["two-invoices.pdf", [{ firstPage: 1, lastPage: 1 }, { firstPage: 2, lastPage: 2 }]],
  ["receipt.png", [{ firstPage: 1, lastPage: 1 }]],
] as const)("a User manually defines %s from its real source without AI or fabricated structured data", async (name, ranges) => {
  const administrator = await administratorWithCompany();
  await knownSupplierFixture(administrator);
  const user = await companyMember(administrator);
  const worker = testWorker();
  const uploaded = await uploadSourceFile(user.client, worker.jobs, { companyId: administrator.companyId, fileName: name, bytes: fixtureFile(name) });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const failed = await systemClient().from("source_file").update({ status: "failed" }).eq("id", uploaded.value.id);
  if (failed.error) throw failed.error;
  const input = { companyId: administrator.companyId, sourceFileId: uploaded.value.id, ranges: [...ranges] };
  const defined = await defineSourceDocuments(user.client, input);
  expect(defined.ok).toBe(true);
  if (!defined.ok) throw new Error(defined.error);
  const documents = await listDocuments(user.client, input.companyId, input.sourceFileId);
  expect(documents.map((document) => ({ firstPage: document.firstPage, lastPage: document.lastPage }))).toEqual(ranges);
  expect(documents.map((document) => document.status)).toEqual(name === "receipt.png" ? ["needs_review"] : ["needs_review", "needs_review"]);
  for (const document of documents) {
    const target = { companyId: input.companyId, documentId: document.id };
    expect(await listExtractionVersions(user.client, target.companyId, target.documentId)).toEqual([]);
    expect(await correctDocument(user.client, { ...target, basedOnVersion: 0, payload: { ...SAMPLE_EXTRACTION, taxPointDate: null } })).toEqual({ ok: false, error: "tax_point_date_required", findings: [{ field: "taxPointDate", severity: "error", code: "tax_point_date_required" }] });
    expect(await correctDocument(user.client, { ...target, basedOnVersion: 0, payload: REVIEWED_EXTRACTION })).toEqual({ ok: true, value: { version: 1 } });
    expect(await approveDocument(user.client, { ...target, version: 1 })).toEqual({ ok: true, value: null });
  }
  expect(await defineSourceDocuments(user.client, input)).toEqual(defined);
  await worker.jobs.send(splitJob(input.sourceFileId));
  expect(await worker.runJobsConcurrently()).toEqual([]);
  expect((await listDocuments(user.client, input.companyId, input.sourceFileId)).map((document) => document.id)).toEqual(defined.value.documentIds);
  expect((await readSourceFile(user.client, input.companyId, input.sourceFileId))?.bytes).toEqual(fixtureFile(name));
  expect((await getSourceFile(user.client, input.companyId, input.sourceFileId))?.status).toBe("split");
  expect((await getSourceFile(user.client, input.companyId, input.sourceFileId))?.manualDefinition).toMatchObject({ userId: user.userId, at: expect.any(String) });
  expect(await getCompanyAiProcessingAllowance(administrator.client, input.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
  const archived = await exportCompanyData(administrator.client, { async send() {} }, { companyId: input.companyId });
  if (!archived.ok) throw new Error(archived.error);
  const archivedSources = JSON.parse(strFromU8(unzipSync(archived.value.bytes)["source-files.json"]));
  expect(archivedSources[0].manualDefinition).toMatchObject({ userId: user.userId, ranges });
});

it("a reasoned Source exclusion needs no Document or DUZP and reverses into manual work without AI", async () => {
  const context = await administratorWithCompany();
  const worker = testWorker();
  const uploaded = await uploadSourceFile(context.client, worker.jobs, { companyId: context.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const input = { companyId: context.companyId, sourceFileId: uploaded.value.id };
  expect(await restoreSourceFile(context.client, input)).toEqual({ ok: false, error: "source_not_rejected" });
  expect(await excludeSourceFile(context.client, { ...input, reason: " " })).toEqual({ ok: false, error: "exclusion_reason_required" });
  expect(await excludeSourceFile(context.client, { ...input, reason: "Personal receipt" })).toEqual({ ok: true, value: null });
  expect((await getSourceFile(context.client, input.companyId, input.sourceFileId))?.exclusion).toMatchObject({ reason: "Personal receipt", userId: context.userId });
  expect(await listDocuments(context.client, input.companyId, input.sourceFileId)).toEqual([]);
  expect(await restoreSourceFile(context.client, input)).toEqual({ ok: true, value: null });
  expect(await worker.runJobsConcurrently()).toEqual([]);
  expect((await getSourceFile(context.client, input.companyId, input.sourceFileId))?.status).toBe("needs_review");
  expect(await listDocuments(context.client, input.companyId, input.sourceFileId)).toEqual([]);
  expect((await readSourceFile(context.client, input.companyId, input.sourceFileId))?.bytes).toEqual(fixtureFile("receipt.png"));
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

it.each([["manual", "success"], ["excluded", "success"], ["manual", "failure"], ["excluded", "failure"]] as const)("late Split %s/%s and duplicate jobs preserve the human resolution", async (decision, outcome) => {
  const context = await administratorWithCompany();
  const started = gate(); const finish = gate();
  const worker = testWorker(fakeAiProvider({ split: async () => {
    started.release(); await finish.promise;
    if (outcome === "failure") throw new AiProviderError("late_split", "Provider unavailable", { transient: false, platformIntervention: true, classification: "provider_unavailable" });
    return [{ firstPage: 1, lastPage: 1 }, { firstPage: 2, lastPage: 2 }];
  } }));
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  const uploaded = await uploadSourceFile(context.client, worker.jobs, { companyId: context.companyId, fileName: "two-invoices.pdf", bytes: fixtureFile("two-invoices.pdf") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const input = { companyId: context.companyId, sourceFileId: uploaded.value.id };
  await worker.jobs.send(splitJob(input.sourceFileId));
  const running = worker.runJobsConcurrently(); await started.promise;
  if (decision === "manual") expect((await defineSourceDocuments(context.client, { ...input, ranges: [{ firstPage: 1, lastPage: 2 }] })).ok).toBe(true);
  else expect(await excludeSourceFile(context.client, { ...input, reason: "Unusable source" })).toEqual({ ok: true, value: null });
  finish.release(); expect(await running).toEqual([]);
  await worker.jobs.send(splitJob(input.sourceFileId)); expect(await worker.runJobsConcurrently()).toEqual([]);
  expect((await getSourceFile(context.client, input.companyId, input.sourceFileId))?.status).toBe(decision === "manual" ? "split" : "rejected");
  const documents = await listDocuments(context.client, input.companyId, input.sourceFileId);
  expect(documents.map((document) => [document.firstPage, document.lastPage, document.status])).toEqual(decision === "manual" ? [[1, 2, "needs_review"]] : []);
  for (const document of documents) expect(await listExtractionVersions(context.client, input.companyId, document.id)).toEqual([]);
  expect(await getCompanyAiProcessingAllowance(context.client, input.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
});

it.each([true, false])("a late Split failure (platform %s) cannot roll back a fresh explicit retry", async (platformIntervention) => {
  const context = await administratorWithCompany(); const started = gate(); const finish = gate(); let calls = 0;
  const worker = testWorker(fakeAiProvider({ split: async () => {
    if (++calls > 1) return [{ firstPage: 1, lastPage: 1 }];
    started.release(); await finish.promise;
    throw new AiProviderError("late_split", "Provider unavailable", { transient: false, platformIntervention, classification: "provider_unavailable" });
  } }));
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  const uploaded = await uploadSourceFile(context.client, worker.jobs, { companyId: context.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const input = { companyId: context.companyId, sourceFileId: uploaded.value.id };
  const running = worker.runJobsConcurrently(); await started.promise;
  expect(await startManualSourceReview(context.client, input)).toEqual({ ok: true, value: null });
  expect(await retrySplit(context.client, worker.jobs, input)).toEqual({ ok: true, value: null });
  finish.release(); await running;
  expect((await getSourceFile(context.client, input.companyId, input.sourceFileId))?.status).toBe("split");
  const [document] = await listDocuments(context.client, input.companyId, input.sourceFileId);
  expect(document.status).toBe("needs_review");
  expect((await listExtractionVersions(context.client, input.companyId, document.id)).map((version) => version.author.kind)).toEqual(["ai"]);
  expect(await getCompanyAiProcessingAllowance(context.client, input.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
});

it("unresolved Source work blocks finalization, exclusion is separately resolved, and its locked snapshot protects reversal", async () => {
  const context = await administratorWithCompany();
  const uploaded = await uploadSourceFile(context.client, { async send() {} }, { companyId: context.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const input = { companyId: context.companyId, sourceFileId: uploaded.value.id };
  const file = await getSourceFile(context.client, input.companyId, input.sourceFileId);
  if (!file) throw new Error("Source not found");
  const period = pragueDate(file.uploadedAt).slice(0, 7);
  await setCurrentReportingYear(context.client, { companyId: context.companyId, filingFrequency: "monthly", year: Number(period.slice(0, 4)) });
  const reportInput = { companyId: context.companyId, period };
  const pending = await getReportingPeriodReadiness(context.client, reportInput);
  if (!pending.ok) throw new Error(pending.error);
  expect(pending.value.ready).toBe(false);
  expect(pending.value.sourceFiles).toEqual([expect.objectContaining({ sourceFileId: input.sourceFileId, status: "uploaded" })]);
  expect((await generateVatReport(context.client, reportInput)).ok).toBe(true);
  const blockedReport = await getVatReport(context.client, input.companyId, period);
  expect(blockedReport?.documents).toEqual([]);
  expect(blockedReport?.finalization.blockerCount).toBe(1);
  expect(await finalizeVatReport(context.client, { ...reportInput, confirmed: true })).toEqual({ ok: false, error: "readiness_blocked" });
  await excludeSourceFile(context.client, { ...input, reason: "Not an accounting source" });
  const resolved = await getReportingPeriodReadiness(context.client, reportInput);
  if (!resolved.ok) throw new Error(resolved.error);
  expect(resolved.value.ready).toBe(true);
  expect(resolved.value.groups.rejected).toEqual([]);
  expect(resolved.value.sourceFiles).toEqual([expect.objectContaining({ sourceFileId: input.sourceFileId, status: "rejected", exclusionReason: "Not an accounting source" })]);
  expect(resolved.value.snapshot?.freshness).toBe("stale");
  expect(await getVatReport(context.client, input.companyId, period)).toEqual(blockedReport);
  expect((await generateVatReport(context.client, reportInput)).ok).toBe(true);
  expect(await finalizeVatReport(context.client, { ...reportInput, confirmed: true })).toEqual({ ok: true, value: null });
  const locked = await getVatReport(context.client, input.companyId, period);
  expect(await restoreSourceFile(context.client, input)).toEqual({ ok: false, error: "period_locked" });
  expect(await retrySplit(context.client, { async send() {} }, input)).toEqual({ ok: false, error: "period_locked" });
  expect(await defineSourceDocuments(context.client, { ...input, ranges: [{ firstPage: 1, lastPage: 1 }] })).toEqual({ ok: false, error: "period_locked" });
  expect((await context.client.rpc("restore_source_file", { target_source_file_id: input.sourceFileId })).error?.hint).toBe("period_locked");
  expect(await listDocuments(context.client, input.companyId, input.sourceFileId)).toEqual([]);
  expect(await getVatReport(context.client, input.companyId, period)).toEqual(locked);
});

it("manual Source work stays pending in its Upload Batch without inventing a Document review count", async () => {
  const context = await administratorWithCompany();
  const selected = selectFixtureFiles("receipt.png");
  const batch = await beginUploadBatch(context.client, { companyId: context.companyId, fileCount: 1, selectedFiles: selected.selectedFiles });
  if (!batch.ok) throw new Error(batch.error);
  const uploaded = await uploadSourceFile(context.client, { async send() {} }, { companyId: context.companyId, batchId: batch.value.id, ...selected.files[0] });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await finishUploadBatch(context.client, batch.value.id)).toEqual({ ok: true, value: null });
  const input = { companyId: context.companyId, sourceFileId: uploaded.value.id };
  await startManualSourceReview(context.client, input);
  const manual = await getUploadBatch(context.client, context.companyId, batch.value.id);
  expect(manual?.outcome).toBe("processing"); expect(manual?.processingFinishedAt).toBeNull(); expect(manual?.counts.review).toBe(0);
  await excludeSourceFile(context.client, { ...input, reason: "Unusable image" });
  expect((await getUploadBatch(context.client, context.companyId, batch.value.id))?.outcome).toBe("success");
  await restoreSourceFile(context.client, input);
  expect((await getUploadBatch(context.client, context.companyId, batch.value.id))?.processingFinishedAt).toBeNull();
  await defineSourceDocuments(context.client, { ...input, ranges: [{ firstPage: 1, lastPage: 1 }] });
  const defined = await getUploadBatch(context.client, context.companyId, batch.value.id);
  expect(defined?.outcome).toBe("success"); expect(defined?.counts.review).toBe(1); expect(defined?.sourceFiles[0].documents).toHaveLength(1);
});

it.each([
  [], null, {}, [{ firstPage: 0, lastPage: 1 }], [{ firstPage: 1.5, lastPage: 2 }],
  [{ firstPage: 1, lastPage: 3 }], [{ firstPage: 2, lastPage: 1 }],
  [{ firstPage: 1, lastPage: 2 }, { firstPage: 2, lastPage: 2 }],
  [{ firstPage: null, lastPage: 1 }], [{ firstPage: "1", lastPage: 1 }],
  [{ firstPage: 1, lastPage: 1, taxPointDate: "2026-10-01" }],
])("the database refuses invalid or non-boundary Source data %j without creating Documents", async (ranges) => {
  const context = await administratorWithCompany();
  const uploaded = await uploadSourceFile(context.client, { async send() {} }, { companyId: context.companyId, fileName: "two-invoices.pdf", bytes: fixtureFile("two-invoices.pdf") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const refused = await context.client.rpc("define_source_documents", { target_source_file_id: uploaded.value.id, document_ranges: ranges });
  expect(refused.error).toMatchObject({ code: "P0001", hint: "invalid_source_ranges" });
  expect(await listDocuments(context.client, context.companyId, uploaded.value.id)).toEqual([]);
  expect((await getSourceFile(context.client, context.companyId, uploaded.value.id))?.status).toBe("uploaded");
});

async function uploadedSource() {
  const context = await administratorWithCompany();
  await knownSupplierFixture(context);
  const uploaded = await uploadSourceFile(context.client, { async send() {} }, { companyId: context.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const file = await getSourceFile(context.client, context.companyId, uploaded.value.id);
  if (!file) throw new Error("Source fixture is missing");
  const period = pragueDate(file.uploadedAt).slice(0, 7);
  await setCurrentReportingYear(context.client, { companyId: context.companyId, filingFrequency: "monthly", year: Number(period.slice(0, 4)) });
  return { ...context, sourceFileId: file.id, period };
}

it("foreign actors cannot define, exclude, restore, inspect readiness or mutate Source recovery metadata", async () => {
  const own = await uploadedSource(); const foreign = await administratorWithCompany();
  const input = { companyId: own.companyId, sourceFileId: own.sourceFileId };
  expect(await defineSourceDocuments(foreign.client, { ...input, ranges: [{ firstPage: 1, lastPage: 1 }] })).toEqual({ ok: false, error: "forbidden" });
  expect(await startManualSourceReview(foreign.client, input)).toEqual({ ok: false, error: "forbidden" });
  expect(await excludeSourceFile(foreign.client, { ...input, reason: "Foreign" })).toEqual({ ok: false, error: "forbidden" });
  expect(await restoreSourceFile(foreign.client, input)).toEqual({ ok: false, error: "forbidden" });
  const attempts = [
    await foreign.client.rpc("define_source_documents", { target_source_file_id: own.sourceFileId, document_ranges: [{ firstPage: 1, lastPage: 1 }] }),
    await foreign.client.rpc("exclude_source_file", { target_source_file_id: own.sourceFileId, exclusion_reason: "Foreign" }),
    await foreign.client.rpc("restore_source_file", { target_source_file_id: own.sourceFileId }),
    await foreign.client.rpc("start_manual_source_review", { target_source_file_id: own.sourceFileId }),
    await foreign.client.rpc("source_file_period_lock", { target_source_file_id: own.sourceFileId }),
    await foreign.client.rpc("source_file_readiness", { target_company_id: own.companyId, target_period: own.period }),
    await own.client.from("source_file").update({ exclusion_reason: "Forged", status: "rejected", split_request_id: crypto.randomUUID(), page_count: 99 }).eq("id", own.sourceFileId),
  ];
  for (const attempt of attempts) expect(attempt.error?.code).toBe("42501");
  expect((await getSourceFile(own.client, own.companyId, own.sourceFileId))?.status).toBe("uploaded");
});

it("Source exclusion and reversal retain actual audit actors and original bytes in the Company archive", async () => {
  const context = await uploadedSource(); const input = { companyId: context.companyId, sourceFileId: context.sourceFileId };
  await excludeSourceFile(context.client, { ...input, reason: "Unusable receipt" });
  const exported = await exportCompanyData(context.client, { async send() {} }, { companyId: context.companyId });
  if (!exported.ok) throw new Error(exported.error);
  const entries = unzipSync(exported.value.bytes);
  expect(JSON.parse(strFromU8(entries["documents.json"]))).toEqual([]);
  expect(JSON.parse(strFromU8(entries["source-files.json"]))[0]).toMatchObject({ id: context.sourceFileId, status: "rejected", exclusion: { reason: "Unusable receipt", userId: context.userId, at: expect.any(String) } });
  expect(entries[`source-files/${context.sourceFileId}/receipt.png`]).toEqual(fixtureFile("receipt.png"));
  await restoreSourceFile(context.client, input);
  const events = await listAuditEvents(context.client, context.organizationId);
  expect(events.filter((event) => event.targetId === context.sourceFileId).map((event) => ({ action: event.action, actor: event.actorUserId, payload: event.payload }))).toEqual(expect.arrayContaining([
    { action: "source_file.excluded", actor: context.userId, payload: { reason: "Unusable receipt" } },
    { action: "source_file.exclusion_reversed", actor: context.userId, payload: { reason: "Unusable receipt" } },
  ]));
});

it("a legacy draft missing Source metadata cannot finalize with an old zero blocker count", async () => {
  const context = await uploadedSource(); const input = { companyId: context.companyId, period: context.period };
  await generateVatReport(context.client, input);
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") }); await database.connect();
  try { await database.query("update public.vat_report set result = result - 'sourceFilesReadinessSource', blocker_count = 0 where company_id = $1 and period = $2", [context.companyId, context.period]); }
  finally { await database.end(); }
  expect(await finalizeVatReport(context.client, { ...input, confirmed: true })).toEqual({ ok: false, error: "stale_report" });
  expect(await getPeriodLock(context.client, context.companyId, context.period)).toBeNull();
});

it("legacy locked snapshots without Source entries do not invent a period for a newly arrived Source", async () => {
  const context = await administratorWithCompany(); const reportInput = { companyId: context.companyId, period: "2026-10" };
  await generateVatReport(context.client, reportInput);
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") }); await database.connect();
  try { await database.query("update public.vat_report set result = result - 'sourceFilesReadinessSource' where company_id = $1 and period = $2", [context.companyId, reportInput.period]); }
  finally { await database.end(); }
  expect(await finalizeVatReport(context.client, { ...reportInput, confirmed: true })).toEqual({ ok: true, value: null });
  const before = await getVatReport(context.client, context.companyId, reportInput.period);
  const uploaded = await uploadSourceFile(context.client, { async send() {} }, { companyId: context.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const sourceInput = { companyId: context.companyId, sourceFileId: uploaded.value.id };
  expect(await excludeSourceFile(context.client, { ...sourceInput, reason: "Investigating" })).toEqual({ ok: true, value: null });
  expect(await restoreSourceFile(context.client, sourceInput)).toEqual({ ok: true, value: null });
  const defined = await defineSourceDocuments(context.client, { ...sourceInput, ranges: [{ firstPage: 1, lastPage: 1 }] });
  if (!defined.ok) throw new Error(defined.error);
  const document = { companyId: context.companyId, documentId: defined.value.documentIds[0] };
  expect(await correctDocument(context.client, { ...document, basedOnVersion: 0, payload: REVIEWED_EXTRACTION })).toEqual({ ok: true, value: { version: 1 } });
  expect(await approveDocument(context.client, { ...document, version: 1 })).toEqual({ ok: false, error: "period_locked" });
  expect(await getVatReport(context.client, context.companyId, reportInput.period)).toEqual(before);
});

it("Source resolution racing draft generation refuses the stale Source fingerprint without storing a report", async () => {
  const context = await uploadedSource();
  const outcomes = await sourceCommandsAtCompany(context.companyId,
    "exclude_source_file", () => excludeSourceFile(context.client, { companyId: context.companyId, sourceFileId: context.sourceFileId, reason: "Human resolution" }),
    "save_vat_report", () => generateVatReport(context.client, { companyId: context.companyId, period: context.period }),
  );
  expect(outcomes).toEqual([
    { status: "fulfilled", value: { ok: true, value: null } },
    { status: "fulfilled", value: { ok: false, error: "stale_report" } },
  ]);
  expect(await getVatReport(context.client, context.companyId, context.period)).toBeNull();
});

it.each([true, false])("finalization versus Source reversal (finalize first %s) preserves the authoritative snapshot boundary", async (finalizeFirst) => {
  const context = await uploadedSource(); const sourceInput = { companyId: context.companyId, sourceFileId: context.sourceFileId };
  await excludeSourceFile(context.client, { ...sourceInput, reason: "Resolved source" });
  const reportInput = { companyId: context.companyId, period: context.period };
  await generateVatReport(context.client, reportInput);
  const finalize = () => finalizeVatReport(context.client, { ...reportInput, confirmed: true });
  const restore = () => restoreSourceFile(context.client, sourceInput);
  const outcomes = finalizeFirst
    ? await sourceCommandsAtCompany(context.companyId, "finalize_vat_report", finalize, "restore_source_file", restore)
    : await sourceCommandsAtCompany(context.companyId, "restore_source_file", restore, "finalize_vat_report", finalize);
  expect(outcomes).toEqual([
    { status: "fulfilled", value: { ok: true, value: null } },
    { status: "fulfilled", value: { ok: false, error: finalizeFirst ? "period_locked" : "stale_report" } },
  ]);
  expect((await getSourceFile(context.client, context.companyId, context.sourceFileId))?.status).toBe(finalizeFirst ? "rejected" : "needs_review");
  expect(await getPeriodLock(context.client, context.companyId, context.period)).toEqual(finalizeFirst ? expect.objectContaining({ period: context.period }) : null);
});

/** Database locks coordinate real application commands; observations remain at their public seams. */
async function sourceCommandsAtCompany(companyId: string, firstName: string, first: () => Promise<unknown>, secondName: string, second: () => Promise<unknown>) {
  const barrier = new DatabaseClient({ connectionString: inject("databaseUrl") });
  const observer = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await barrier.connect(); await observer.connect(); const pending: Promise<unknown>[] = [];
  async function blocked(name: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ waiting: boolean }>("select exists (select 1 from pg_stat_activity where pid <> pg_backend_pid() and wait_event_type = 'Lock' and strpos(query, $1) > 0) as waiting", [name]);
      if (result.rows[0].waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Source command did not reach its Company barrier: ${name}`);
  }
  try {
    await barrier.query("begin"); await barrier.query("select 1 from public.company where id = $1 for update", [companyId]);
    pending.push(first()); await blocked(firstName);
    pending.push(second()); await blocked(secondName);
    await barrier.query("commit"); return await Promise.allSettled(pending);
  } finally {
    await barrier.query("rollback"); await Promise.allSettled(pending); await barrier.end(); await observer.end();
  }
}

it("Source readiness and report blockers include all 1001 actual originals beyond the row limit", async () => {
  const context = await uploadedSource();
  const original = await getSourceFile(context.client, context.companyId, context.sourceFileId);
  if (!original) throw new Error("Original is missing");
  const ids = Array.from({ length: 1000 }, () => crypto.randomUUID());
  let next = 0;
  // Actual immutable Storage copies preserve the validated bytes. Only metadata
  // insertion/time is batched as fixture setup; no fake stored objects or Documents.
  await Promise.all(Array.from({ length: 20 }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const copied = await context.client.storage.from("source-files").copy(`${context.companyId}/${context.sourceFileId}`, `${context.companyId}/${id}`);
      if (copied.error) throw copied.error;
    }
  }));
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") }); await database.connect();
  try {
    await database.query(`insert into public.source_file (id, organization_id, company_id, file_name, format, byte_size, sha256, page_count, uploaded_at)
      select id, $2, $3, 'copied-receipt.png', 'png', $4, $5, 1, $6::timestamptz from unnest($1::uuid[]) as input(id)`,
      [ids, context.organizationId, context.companyId, original.byteSize, original.sha256, original.uploadedAt]);
  } finally { await database.end(); }
  const input = { companyId: context.companyId, period: context.period };
  const readiness = await getReportingPeriodReadiness(context.client, input);
  if (!readiness.ok) throw new Error(readiness.error);
  expect(readiness.value.sourceFiles).toHaveLength(1001);
  expect((await generateVatReport(context.client, input)).ok).toBe(true);
  const report = await getVatReport(context.client, context.companyId, context.period);
  expect(report?.documents).toEqual([]); expect(report?.finalization.blockerCount).toBe(1001);
  expect(report?.result.sourceFilesReadinessSource).toHaveLength(1001);
}, 60_000);

it("taking over Source work invalidates a late successful Split before boundaries are saved", async () => {
  const context = await administratorWithCompany(); const started = gate(); const finish = gate();
  const worker = testWorker(fakeAiProvider({ split: async () => { started.release(); await finish.promise; return [{ firstPage: 1, lastPage: 1 }]; } }));
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  const uploaded = await uploadSourceFile(context.client, worker.jobs, { companyId: context.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const input = { companyId: context.companyId, sourceFileId: uploaded.value.id };
  const running = worker.runJobsConcurrently(); await started.promise;
  await startManualSourceReview(context.client, input); finish.release(); expect(await running).toEqual([]);
  expect((await getSourceFile(context.client, input.companyId, input.sourceFileId))?.status).toBe("needs_review");
  expect(await listDocuments(context.client, input.companyId, input.sourceFileId)).toEqual([]);
  expect((await defineSourceDocuments(context.client, { ...input, ranges: [{ firstPage: 1, lastPage: 1 }] })).ok).toBe(true);
  expect(await getCompanyAiProcessingAllowance(context.client, input.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
});

it("a lost platform remediation acknowledgement cannot park a later Source takeover and explicit retry", async () => {
  const context = await administratorWithCompany(); const operator = await promotedSuperAdministrator("Source recovery operator", "source-recovery"); let unavailable = true;
  const worker = testWorker(fakeAiProvider({ split: () => {
    if (unavailable) throw new AiProviderError("unavailable", "Unavailable", { transient: false, platformIntervention: true, classification: "provider_unavailable" });
    return [{ firstPage: 1, lastPage: 1 }];
  } }));
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  const uploaded = await uploadSourceFile(context.client, worker.jobs, { companyId: context.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toEqual([]);
  const input = { companyId: context.companyId, sourceFileId: uploaded.value.id };
  await expect(resumePlatformAiProcessing(operator.client, { async send() {
    await startManualSourceReview(context.client, input); await retrySplit(context.client, worker.jobs, input);
    throw new Error("Lost broker acknowledgement");
  } }, { companyId: context.companyId })).rejects.toThrow("Lost broker acknowledgement");
  expect((await getSourceFile(context.client, input.companyId, input.sourceFileId))?.status).toBe("uploaded");
  unavailable = false; expect(await worker.runJobs()).toEqual([]);
  expect((await getSourceFile(context.client, input.companyId, input.sourceFileId))?.status).toBe("split");
  const [document] = await listDocuments(context.client, input.companyId, input.sourceFileId);
  expect((await listExtractionVersions(context.client, input.companyId, document.id)).map((version) => version.author.kind)).toEqual(["ai"]);
});

it.each(["\t\n", "x".repeat(501)])("Source exclusion requires a short meaningful reason %j", async (reason) => {
  const context = await uploadedSource();
  expect(await excludeSourceFile(context.client, { companyId: context.companyId, sourceFileId: context.sourceFileId, reason })).toEqual({ ok: false, error: "exclusion_reason_required" });
  expect((await getSourceFile(context.client, context.companyId, context.sourceFileId))?.status).toBe("uploaded");
});

it("actual Split recording serializes behind takeover without a Source/Company lock cycle", async () => {
  const context = await uploadedSource(); const system = systemClient();
  const requestId = await sourceSplitRequestFixture(system, context.sourceFileId);
  const input = { companyId: context.companyId, sourceFileId: context.sourceFileId };
  const record = () => system.rpc("record_split", { target_source_file_id: input.sourceFileId, target_split_request_id: requestId, source_ranges: [{ firstPage: 1, lastPage: 1 }] });
  const outcomes = await sourceCommandsAtCompany(context.companyId,
    "start_manual_source_review", () => startManualSourceReview(context.client, input),
    "record_split", async () => await record(),
  );
  expect(outcomes).toMatchObject([
    { status: "fulfilled", value: { ok: true, value: null } },
    { status: "fulfilled", value: { error: null } },
  ]);
  expect(await listDocuments(context.client, input.companyId, input.sourceFileId)).toEqual([]);
  const defined = await defineSourceDocuments(context.client, { ...input, ranges: [{ firstPage: 1, lastPage: 1 }] });
  if (!defined.ok) throw new Error(defined.error);
  const document = { companyId: context.companyId, documentId: defined.value.documentIds[0] };
  await correctDocument(context.client, { ...document, basedOnVersion: 0, payload: REVIEWED_EXTRACTION });
  expect(await approveDocument(context.client, { ...document, version: 1 })).toEqual({ ok: true, value: null });
  expect((await record()).error).toBeNull();
  expect((await listExtractionVersions(context.client, input.companyId, document.documentId)).map((version) => version.author.kind)).toEqual(["user"]);
  expect((await getSourceFile(context.client, input.companyId, input.sourceFileId))?.status).toBe("split");
});
