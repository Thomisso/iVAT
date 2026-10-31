import { sourceSplitRequestFixture } from "./support/source-request";
import { expect, inject, it } from "vitest";
import { Client as DatabaseClient } from "pg";
import { PDFDocument } from "pdf-lib";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { approveDocument, correctDocument, getDocument, listDocuments, listExtractionVersions, startManualDocumentReview, rejectDocument, restoreDocument, reprocessDocument, returnDocumentToReview, updateDocumentReporting, splitDocument, mergeDocuments, moveDocumentPage } from "@/application/documents";
import { uploadSourceFile, readSourceFile } from "@/application/source-files";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { administratorWithCompany, companyMember, assignAiConfigurationFixture, companyDetails } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { systemClient, testWorker } from "./support/worker";
import { extractJob } from "@/application/processing";
import { AiProviderError } from "@/application/ai-provider";
import { createCompany, setCurrentReportingYear } from "@/application/companies";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { listAuditEvents } from "@/application/audit";
import { generateVatReport, finalizeVatReport } from "@/application/vat-reports";
import { promotedSuperAdministrator } from "./support/platform";
import { resumePlatformAiProcessing } from "@/application/ai-configurations";
import { exportCompanyData } from "@/application/company-deletion";
import { unzipSync, strFromU8 } from "fflate";
async function unextractedDocument(status: "failed" | "waiting_for_platform" | "uploaded" | "waiting_for_allowance" | "processing" = "failed", administrator?: Awaited<ReturnType<typeof administratorWithCompany>>) {
  administrator ??= await administratorWithCompany();
  const uploaded = await uploadSourceFile(administrator.client, { async send() {} }, {
    companyId: administrator.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png"),
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const system = systemClient();
  const split = await system.rpc("record_split", { target_source_file_id: uploaded.value.id, target_split_request_id: await sourceSplitRequestFixture(system, uploaded.value.id), source_ranges: [{ firstPage: 1, lastPage: 1 }] });
  if (split.error) throw split.error;
  const [document] = await listDocuments(administrator.client, administrator.companyId, uploaded.value.id);
  const changed = await system.from("document").update({ status }).eq("id", document.id);
  if (changed.error) throw changed.error;
  return { ...administrator, documentId: document.id, sourceFileId: uploaded.value.id, documentImportPeriod: document.importDate.slice(0, 7) };
}

it.each(["failed", "waiting_for_platform", "uploaded", "waiting_for_allowance", "processing"] as const)("a Company User takes over %s work without AI configuration and records its first immutable User Version", async (status) => {
  const context = await unextractedDocument(status);
  const user = await companyMember(context);
  const input = { companyId: context.companyId, documentId: context.documentId };
  expect(await startManualDocumentReview(user.client, input)).toEqual({ ok: true, value: null });
  expect(await startManualDocumentReview(user.client, input)).toEqual({ ok: true, value: null });
  expect((await getDocument(user.client, input.companyId, input.documentId))?.status).toBe("needs_review");
  expect(await listExtractionVersions(user.client, input.companyId, input.documentId)).toEqual([]);
  expect(await correctDocument(user.client, { ...input, basedOnVersion: 0, payload: { ...SAMPLE_EXTRACTION, taxPointDate: null } }))
    .toEqual({ ok: false, error: "tax_point_date_required" });
  expect(await correctDocument(user.client, { ...input, basedOnVersion: 0, payload: SAMPLE_EXTRACTION }))
    .toEqual({ ok: true, value: { version: 1 } });
  expect((await listExtractionVersions(user.client, input.companyId, input.documentId))[0].author)
    .toEqual({ kind: "user", userId: user.userId });
  expect(await approveDocument(user.client, { ...input, version: 1 })).toEqual({ ok: true, value: null });
  expect((await readSourceFile(user.client, input.companyId, context.sourceFileId))?.bytes).toEqual(fixtureFile("receipt.png"));
  expect(await getCompanyAiProcessingAllowance(context.client, context.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
});

it("excludes an unextracted Document with a reason, retains its original, and reverses into manual review", async () => {
  const context = await unextractedDocument();
  const input = { companyId: context.companyId, documentId: context.documentId };
  expect(await rejectDocument(context.client, { ...input, reason: " " })).toEqual({ ok: false, error: "exclusion_reason_required" });
  const direct = await context.client.rpc("reject_document", { target_document_id: context.documentId });
  expect(direct.error?.hint).toBe("exclusion_reason_required");
  expect(await rejectDocument(context.client, { ...input, reason: "  Personal receipt  " })).toEqual({ ok: true, value: null });
  const excluded = await getDocument(context.client, input.companyId, input.documentId);
  expect(excluded?.status).toBe("rejected");
  expect(excluded?.exclusion).toMatchObject({ reason: "Personal receipt", userId: context.userId });
  expect(await listExtractionVersions(context.client, input.companyId, input.documentId)).toEqual([]);
  expect((await readSourceFile(context.client, input.companyId, context.sourceFileId))?.bytes).toEqual(fixtureFile("receipt.png"));
  expect(await restoreDocument(context.client, input)).toEqual({ ok: true, value: null });
  expect((await getDocument(context.client, input.companyId, input.documentId))?.exclusion).toBeUndefined();
  expect(await correctDocument(context.client, { ...input, basedOnVersion: 0, payload: SAMPLE_EXTRACTION })).toEqual({ ok: true, value: { version: 1 } });
  expect(await approveDocument(context.client, { ...input, version: 1 })).toEqual({ ok: true, value: null });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

it.each([
  ["manual", "success"], ["excluded", "success"], ["manual", "failure"], ["excluded", "failure"],
] as const)("late AI %s/%s and duplicate jobs preserve the human terminal state without allowance consumption", async (decision, outcome) => {
  const context = await unextractedDocument("uploaded");
  const started = gate();
  const finish = gate();
  const worker = testWorker(fakeAiProvider({ extract: async () => {
    started.release(); await finish.promise;
    if (outcome === "failure") throw new AiProviderError("late_failure", "Provider unavailable", { transient: false, platformIntervention: true, classification: "provider_unavailable" });
    return SAMPLE_EXTRACTION;
  } }));
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  const input = { companyId: context.companyId, documentId: context.documentId };
  const before = await getCompanyAiProcessingAllowance(context.client, context.companyId);
  const running = worker.runJobsConcurrently();
  await started.promise;
  if (decision === "manual") {
    expect(await startManualDocumentReview(context.client, input)).toEqual({ ok: true, value: null });
    expect(await correctDocument(context.client, { ...input, basedOnVersion: 0, payload: { ...SAMPLE_EXTRACTION, documentNumber: "HUMAN" } })).toEqual({ ok: true, value: { version: 1 } });
    expect(await approveDocument(context.client, { ...input, version: 1 })).toEqual({ ok: true, value: null });
  } else {
    expect(await rejectDocument(context.client, { ...input, reason: "Personal receipt" })).toEqual({ ok: true, value: null });
  }
  finish.release();
  expect(await running).toEqual([]);
  worker.releaseDelayedJobs();
  await worker.jobs.send(extractJob(context.documentId));
  expect(await worker.runJobsConcurrently()).toEqual([]);
  expect((await getDocument(context.client, input.companyId, input.documentId))?.status).toBe(decision === "manual" ? "approved" : "rejected");
  const versions = await listExtractionVersions(context.client, input.companyId, input.documentId);
  expect(versions.map((version) => version.payload.documentNumber)).toEqual(decision === "manual" ? ["HUMAN"] : []);
  expect(await getCompanyAiProcessingAllowance(context.client, context.companyId)).toEqual(before);
});

it.each([true, false])("late AI failure (platform intervention %s) cannot roll back a fresh retry generation", async (platformIntervention) => {
  const context = await unextractedDocument("uploaded");
  const started = gate();
  const finish = gate();
  let attempts = 0;
  const worker = testWorker(fakeAiProvider({ extract: async () => {
    if (++attempts > 1) return SAMPLE_EXTRACTION;
    started.release(); await finish.promise;
    throw new AiProviderError("late_failure", "Provider unavailable", { transient: false, platformIntervention, classification: "provider_unavailable" });
  } }));
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  const input = { companyId: context.companyId, documentId: context.documentId };
  const running = worker.runJobsConcurrently();
  await started.promise;
  await startManualDocumentReview(context.client, input);
  await correctDocument(context.client, { ...input, basedOnVersion: 0, payload: { ...SAMPLE_EXTRACTION, documentNumber: "HUMAN" } });
  expect(await reprocessDocument(context.client, worker.jobs, input)).toEqual({ ok: true, value: null });
  finish.release();
  await running;
  expect((await getDocument(context.client, input.companyId, input.documentId))?.status).toBe("needs_review");
  expect((await listExtractionVersions(context.client, input.companyId, input.documentId)).map((version) => version.author.kind)).toEqual(["user", "ai"]);
  expect(await getCompanyAiProcessingAllowance(context.client, context.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
});


it("refuses foreign recovery, exclusion and reversal through commands and direct RPCs", async () => {
  const own = await unextractedDocument();
  const foreign = await administratorWithCompany();
  const input = { companyId: own.companyId, documentId: own.documentId };
  expect(await startManualDocumentReview(foreign.client, input)).toEqual({ ok: false, error: "forbidden" });
  expect(await rejectDocument(foreign.client, { ...input, reason: "Foreign" })).toEqual({ ok: false, error: "forbidden" });
  expect(await restoreDocument(foreign.client, input)).toEqual({ ok: false, error: "forbidden" });
  for (const rpc of ["start_manual_document_review", "restore_document", "reject_document"] as const) {
    expect((await foreign.client.rpc(rpc, { target_document_id: own.documentId })).error?.code).toBe("42501");
  }
  expect((await getDocument(own.client, input.companyId, input.documentId))?.status).toBe("failed");
});

it("keeps reasoned exclusion resolved in readiness and preserves both decisions in the Audit Trail", async () => {
  const context = await unextractedDocument();
  const input = { companyId: context.companyId, documentId: context.documentId };
  await rejectDocument(context.client, { ...input, reason: "Not a business expense" });
  // The real upload date is informational; generate its year rather than assuming the runner's clock is 2026.
  expect(await setCurrentReportingYear(context.client, {
    companyId: context.companyId, filingFrequency: "monthly", year: Number(context.documentImportPeriod.slice(0, 4)),
  })).toEqual({ ok: true, value: null });
  const readiness = await getReportingPeriodReadiness(context.client, { companyId: context.companyId, period: context.documentImportPeriod });
  expect(readiness.ok).toBe(true);
  if (!readiness.ok) throw new Error(readiness.error);
  expect(readiness.value.groups.rejected).toContain(context.documentId);
  expect(readiness.value.blockers).toEqual([]);
  await restoreDocument(context.client, input);
  const events = await listAuditEvents(context.client, context.organizationId);
  expect(events.filter((event) => event.targetId === context.documentId).map((event) => ({ action: event.action, actor: event.actorUserId, payload: event.payload }))).toEqual(expect.arrayContaining([
    { action: "document.rejected", actor: context.userId, payload: { reason: "Not a business expense" } },
    { action: "document.exclusion_reversed", actor: context.userId, payload: { reason: "Not a business expense" } },
  ]));
});

it("preserves the first recovered User Version in a locked period but refuses its edits, approval and exclusion", async () => {
  const context = await administratorWithCompany();
  const period = { companyId: context.companyId, period: "2026-10" };
  expect((await generateVatReport(context.client, period)).ok).toBe(true);
  expect(await finalizeVatReport(context.client, { ...period, confirmed: true })).toEqual({ ok: true, value: null });
  const document = await unextractedDocument("failed", context);
  const input = { companyId: context.companyId, documentId: document.documentId };
  expect(await startManualDocumentReview(context.client, input)).toEqual({ ok: true, value: null });
  expect(await correctDocument(context.client, { ...input, basedOnVersion: 0, payload: SAMPLE_EXTRACTION })).toEqual({ ok: true, value: { version: 1 } });
  expect(await correctDocument(context.client, { ...input, basedOnVersion: 1, payload: SAMPLE_EXTRACTION })).toEqual({ ok: false, error: "period_locked" });
  expect(await approveDocument(context.client, { ...input, version: 1 })).toEqual({ ok: false, error: "period_locked" });
  expect(await rejectDocument(context.client, { ...input, reason: "Not business" })).toEqual({ ok: false, error: "period_locked" });
});


it("a failed remediation dispatch cannot restore a wait over a later human takeover and retry", async () => {
  const context = await unextractedDocument("uploaded");
  const operator = await promotedSuperAdministrator("Recovery operator", "document-recovery");
  let unavailable = true;
  const worker = testWorker(fakeAiProvider({ extract: () => {
    if (unavailable) throw new AiProviderError("unavailable", "Unavailable", { transient: false, platformIntervention: true, classification: "provider_unavailable" });
    return SAMPLE_EXTRACTION;
  } }));
  await assignAiConfigurationFixture(context.client, worker.jobs, { companyId: context.companyId, provider: worker.ai });
  expect(await worker.runJobs()).toEqual([]);
  const input = { companyId: context.companyId, documentId: context.documentId };
  expect((await getDocument(context.client, input.companyId, input.documentId))?.status).toBe("waiting_for_platform");
  await expect(resumePlatformAiProcessing(operator.client, { async send() {
    await startManualDocumentReview(context.client, input);
    await correctDocument(context.client, { ...input, basedOnVersion: 0, payload: SAMPLE_EXTRACTION });
    await reprocessDocument(context.client, worker.jobs, input);
    throw new Error("Lost broker acknowledgement");
  } }, { companyId: context.companyId })).rejects.toThrow("Lost broker acknowledgement");
  expect((await getDocument(context.client, input.companyId, input.documentId))?.status).toBe("uploaded");
  unavailable = false;
  expect(await worker.runJobs()).toEqual([]);
  expect((await listExtractionVersions(context.client, input.companyId, input.documentId)).map((version) => version.author.kind)).toEqual(["user", "ai"]);
  expect(await getCompanyAiProcessingAllowance(context.client, context.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
});


it("exports the exclusion receipt and unchanged original without fabricating an Extraction Version", async () => {
  const context = await unextractedDocument();
  await rejectDocument(context.client, { companyId: context.companyId, documentId: context.documentId, reason: "Personal receipt" });
  const archive = await exportCompanyData(context.client, { async send() {} }, { companyId: context.companyId });
  if (!archive.ok) throw new Error(archive.error);
  const entries = unzipSync(archive.value.bytes);
  const documents = JSON.parse(strFromU8(entries["documents.json"]));
  expect(documents).toEqual([expect.objectContaining({
    id: context.documentId,
    status: "rejected",
    exclusion: { reason: "Personal receipt", userId: context.userId, at: expect.any(String) },
    extractionVersions: [],
  })]);
  expect(entries[`source-files/${context.sourceFileId}/receipt.png`]).toEqual(fixtureFile("receipt.png"));
});

it("an excluded Version in a locked period cannot be restored by command or direct RPC", async () => {
  const context = await unextractedDocument();
  const input = { companyId: context.companyId, documentId: context.documentId };
  await startManualDocumentReview(context.client, input);
  await correctDocument(context.client, { ...input, basedOnVersion: 0, payload: SAMPLE_EXTRACTION });
  await rejectDocument(context.client, { ...input, reason: "Personal receipt" });
  const period = { companyId: context.companyId, period: "2026-10" };
  expect((await generateVatReport(context.client, period)).ok).toBe(true);
  expect(await finalizeVatReport(context.client, { ...period, confirmed: true })).toEqual({ ok: true, value: null });
  expect(await restoreDocument(context.client, input)).toEqual({ ok: false, error: "period_locked" });
  expect((await context.client.rpc("restore_document", { target_document_id: context.documentId })).error?.hint).toBe("period_locked");
  expect((await getDocument(context.client, input.companyId, input.documentId))?.exclusion?.reason).toBe("Personal receipt");
});



it("a worker releasing its reservation cannot deadlock a concurrent manual takeover", async () => {
  const context = await unextractedDocument("uploaded");
  const worker = testWorker();
  await assignAiConfigurationFixture(context.client, { async send() {} }, { companyId: context.companyId, provider: worker.ai });
  const system = systemClient();
  const reservationId = crypto.randomUUID();
  const document = await system.from("document").select("extraction_request_id").eq("id", context.documentId).single();
  if (document.error) throw document.error;
  expect((await system.rpc("reserve_ai_processing", {
    target_document_id: context.documentId,
    target_extraction_request_id: document.data.extraction_request_id,
    target_reservation_id: reservationId,
  })).data).toBe("reserved");

  // Queue takeover first at Company, then the actual finally-cleanup RPC.
  // The predecessor release held reservation/Document before joining this queue,
  // so unlocking Company deterministically created a deadlock with takeover.
  const barrier = new DatabaseClient({ connectionString: inject("databaseUrl") });
  const observer = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await barrier.connect();
  await observer.connect();
  let takeover: ReturnType<typeof startManualDocumentReview> | undefined;
  let released: PromiseLike<unknown> | undefined;
  try {
    await barrier.query("begin");
    await barrier.query("select 1 from public.company where id = $1 for update", [context.companyId]);
    const input = { companyId: context.companyId, documentId: context.documentId };
    takeover = startManualDocumentReview(context.client, input);
    await waitForBlockedProcessingCommand(observer, "start_manual_document_review");
    const cleanup = system.rpc("release_ai_processing_reservation", { target_reservation_id: reservationId }).then((result) => result);
    released = cleanup;
    await waitForBlockedProcessingCommand(observer, "release_ai_processing_reservation");
    await barrier.query("commit");
    const [human, workerCleanup] = await Promise.allSettled([takeover, cleanup]);
    expect(human).toEqual({ status: "fulfilled", value: { ok: true, value: null } });
    expect(workerCleanup).toMatchObject({ status: "fulfilled", value: { error: null } });
    expect((await getDocument(context.client, input.companyId, input.documentId))?.status).toBe("needs_review");
    expect(await correctDocument(context.client, { ...input, basedOnVersion: 0, payload: SAMPLE_EXTRACTION })).toEqual({ ok: true, value: { version: 1 } });
    expect(await approveDocument(context.client, { ...input, version: 1 })).toEqual({ ok: true, value: null });
    // Duplicate old cleanup must preserve the human terminal state too.
    expect((await system.rpc("release_ai_processing_reservation", { target_reservation_id: reservationId })).error).toBeNull();
    expect((await getDocument(context.client, input.companyId, input.documentId))?.status).toBe("approved");
    expect(await getCompanyAiProcessingAllowance(context.client, context.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
  } finally {
    await barrier.query("rollback");
    await Promise.allSettled([takeover, released].filter((pending) => pending !== undefined));
    await barrier.end();
    await observer.end();
  }
});

/** Lock inspection coordinates the fixture; all business assertions use application queries. */
async function waitForBlockedProcessingCommand(database: DatabaseClient, command: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const blocked = await database.query<{ blocked: boolean }>(
      "select exists (select 1 from pg_stat_activity where pid <> pg_backend_pid() and wait_event_type = 'Lock' and strpos(query, $1) > 0) as blocked",
      [command],
    );
    if (blocked.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Processing command did not reach the fixture lock: ${command}`);
}

it("concurrent correction and approval serialize into a stale-version refusal rather than a deadlock", async () => {
  const context = await unextractedDocument();
  const input = { companyId: context.companyId, documentId: context.documentId };
  await startManualDocumentReview(context.client, input);
  await correctDocument(context.client, { ...input, basedOnVersion: 0, payload: SAMPLE_EXTRACTION });
  const outcomes = await concurrentDocumentCommands(context.companyId,
    "correct_document", () => correctDocument(context.client, { ...input, basedOnVersion: 1, payload: { ...SAMPLE_EXTRACTION, documentNumber: "CORRECTED" } }),
    "approve_document", () => approveDocument(context.client, { ...input, version: 1 }),
  );
  expect(outcomes).toEqual([
    { status: "fulfilled", value: { ok: true, value: { version: 2 } } },
    { status: "fulfilled", value: { ok: false, error: "stale_version" } },
  ]);
  expect((await getDocument(context.client, input.companyId, input.documentId))?.status).toBe("needs_review");
  expect((await listExtractionVersions(context.client, input.companyId, input.documentId)).map((version) => version.payload.documentNumber)).toEqual(["FV-2026-0001", "CORRECTED"]);
  expect(await approveDocument(context.client, { ...input, version: 2 })).toEqual({ ok: true, value: null });
});

/** Queue both real commands at Company in a known order, without mocking either command. */
async function concurrentDocumentCommands(
  companyId: string,
  firstName: string, firstCommand: () => Promise<unknown>,
  secondName: string, secondCommand: () => Promise<unknown>,
) {
  const barrier = new DatabaseClient({ connectionString: inject("databaseUrl") });
  const observer = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await barrier.connect();
  await observer.connect();
  const pending: Promise<unknown>[] = [];
  try {
    await barrier.query("begin");
    await barrier.query("select 1 from public.company where id = $1 for update", [companyId]);
    pending.push(firstCommand());
    await waitForBlockedProcessingCommand(observer, firstName);
    pending.push(secondCommand());
    await waitForBlockedProcessingCommand(observer, secondName);
    await barrier.query("commit");
    return await Promise.allSettled(pending);
  } finally {
    await barrier.query("rollback");
    await Promise.allSettled(pending);
    await barrier.end();
    await observer.end();
  }
}


it.each([
  ["return", "return_document_to_review"], ["claim", "update_document_reporting"],
  ["split", "split_document"], ["merge", "merge_documents"], ["move", "move_document_page"],
] as const)("concurrent correction and %s preserve ordinary Document decisions without a lock cycle", async (operation, rpc) => {
  const context = await pageCorrectionDocuments();
  const [left, right] = context.documents;
  const input = { companyId: context.companyId, documentId: left.id };
  if (operation === "return") await approveDocument(context.client, { ...input, version: 1 });
  const noJobs = { async send() {} };
  const decisions = {
    return: () => returnDocumentToReview(context.client, input),
    claim: () => updateDocumentReporting(context.client, { ...input, claimedReportingPeriod: "2026-11" }),
    split: () => splitDocument(context.client, noJobs, { ...input, splitAfterPage: 1 }),
    merge: () => mergeDocuments(context.client, noJobs, { companyId: context.companyId, leftDocumentId: left.id, rightDocumentId: right.id }),
    move: () => moveDocumentPage(context.client, noJobs, { companyId: context.companyId, sourceDocumentId: left.id, targetDocumentId: right.id, page: 2 }),
  };
  const outcomes = await concurrentDocumentCommands(context.companyId,
    "correct_document", () => correctDocument(context.client, { ...input, basedOnVersion: 1, payload: SAMPLE_EXTRACTION }),
    rpc, decisions[operation],
  );
  expect(outcomes).toEqual([
    { status: "fulfilled", value: operation === "return" ? { ok: false, error: "not_in_review" } : { ok: true, value: { version: 2 } } },
    { status: "fulfilled", value: { ok: true, value: null } },
  ]);
  expect((await listExtractionVersions(context.client, input.companyId, input.documentId)).map((version) => version.version)).toEqual(operation === "return" ? [1] : [1, 2]);
  const documents = await listDocuments(context.client, context.companyId, context.sourceFileId);
  expect(documents.map((document) => [document.firstPage, document.lastPage])).toEqual(
    operation === "merge" ? [[1, 4]] : operation === "split" ? [[1, 1], [2, 2], [3, 4]] : operation === "move" ? [[1, 1], [2, 4]] : [[1, 2], [3, 4]],
  );
  if (operation === "claim") expect((await getDocument(context.client, input.companyId, input.documentId))?.claimedReportingPeriod).toBe("2026-11");
});

async function pageCorrectionDocuments(administrator?: Awaited<ReturnType<typeof administratorWithCompany>>) {
  administrator ??= await administratorWithCompany();
  const pdf = await PDFDocument.create();
  for (let page = 0; page < 4; page++) pdf.addPage();
  const uploaded = await uploadSourceFile(administrator.client, { async send() {} }, {
    companyId: administrator.companyId, fileName: "pages.pdf", bytes: await pdf.save(),
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const split = await systemClient().rpc("record_split", { target_source_file_id: uploaded.value.id, target_split_request_id: await sourceSplitRequestFixture(systemClient(), uploaded.value.id), source_ranges: [{ firstPage: 1, lastPage: 2 }, { firstPage: 3, lastPage: 4 }] });
  if (split.error) throw split.error;
  const documents = await listDocuments(administrator.client, administrator.companyId, uploaded.value.id);
  for (const document of documents) {
    const input = { companyId: administrator.companyId, documentId: document.id };
    await startManualDocumentReview(administrator.client, input);
    await correctDocument(administrator.client, { ...input, basedOnVersion: 0, payload: SAMPLE_EXTRACTION });
  }
  return { ...administrator, sourceFileId: uploaded.value.id, documents };
}


it("cross-Company page inputs are refused before either Company is locked, preserving both histories", async () => {
  const left = await pageCorrectionDocuments();
  const created = await createCompany(left.client, { ...companyDetails(), organizationId: left.organizationId });
  if (!created.ok) throw new Error(created.error);
  const right = await pageCorrectionDocuments({ ...left, companyId: created.value.id });
  const before = await Promise.all([left, right].map((context) => listExtractionVersions(context.client, context.companyId, context.documents[0].id)));
  const barrier = new DatabaseClient({ connectionString: inject("databaseUrl") });
  const observer = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await barrier.connect(); await observer.connect();
  const pending: PromiseLike<unknown>[] = [];
  try {
    await barrier.query("begin");
    await barrier.query("select 1 from public.company where id = any($1::uuid[]) order by id for update", [[left.companyId, right.companyId]]);
    for (const rpc of ["merge_documents", "move_document_page"] as const) {
      let completed = false;
      const parameters = rpc === "merge_documents"
        ? { left_document_id: left.documents[0].id, right_document_id: right.documents[0].id }
        : { source_document_id: left.documents[0].id, target_document_id: right.documents[0].id, page: 2 };
      const call = left.client.rpc(rpc, parameters).then((result) => { completed = true; return result; });
      pending.push(call);
      const deadline = Date.now() + 5_000;
      while (!completed && Date.now() < deadline) {
        const lock = await observer.query<{ blocked: boolean }>("select exists (select 1 from pg_stat_activity where pid <> pg_backend_pid() and wait_event_type = 'Lock' and strpos(query, $1) > 0) as blocked", [rpc]);
        expect(lock.rows[0].blocked).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(completed).toBe(true);
      expect((await call).error).toMatchObject({ code: "P0001", hint: "invalid_split_boundary" });
    }
  } finally {
    await barrier.query("rollback");
    await Promise.allSettled(pending);
    await barrier.end(); await observer.end();
  }
  expect(await Promise.all([left, right].map((context) => listExtractionVersions(context.client, context.companyId, context.documents[0].id)))).toEqual(before);
  for (const context of [left, right]) expect((await getDocument(context.client, context.companyId, context.documents[0].id))?.status).toBe("needs_review");
});
