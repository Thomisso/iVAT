import { createClient } from "@supabase/supabase-js";
import { asUserClient } from "@/application/client";
import { Client as DatabaseClient } from "pg";
import { pragueDate } from "@/application/reporting-periods";
import { unzipSync, strFromU8 } from "fflate";
import { exportCompanyData, getCompanyDataExportStatus } from "@/application/company-deletion";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import sharp from "sharp";
import { listAuditEvents } from "@/application/audit";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, inject } from "vitest";
import { beginUploadBatch, finishUploadBatch, getUploadBatch, deleteUploadBatch } from "@/application/upload-batches";
import { uploadSourceFile, readSourceFile, readSourceFileDerivative, getSourceFile } from "@/application/source-files";
import { getDocument, listExtractionVersions, readDocumentPages, splitDocument, listCompanyDocuments, startManualDocumentReview, reprocessDocument, correctDocument, approveDocument } from "@/application/documents";
import { getPhotoGroup, readPhotoGroupBasis, recoverPhotoGroup } from "@/application/photo-groups";
import { listMemberships, removeMembership } from "@/application/memberships";
import { setOrganizationMfaRequired } from "@/application/mfa";
import { generateVatReport, finalizeVatReport, getVatReport } from "@/application/vat-reports";
import { setCurrentReportingYear } from "@/application/companies";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { administratorWithCompany, assignAiConfigurationFixture, companyMember, knownSupplierFixture } from "./support/fixtures";
import { fixtureFile, heicFixture, rotatedHeicFixture, selectUploadFiles } from "./support/files";
import { companySourceFileRowLimitProbe, withPostgrestRowLimit } from "./support/postgrest";
import { PDFDocument } from "pdf-lib";
import { supabaseHttpGateway } from "./support/supabase-http-gateway";
import { systemClient, testWorker } from "./support/worker";

const jpegHash = "0896be252af2407fd12029be53cc41ea9747e33613fb5702a0e8c5b39b1fc7c1";
const pngHash = "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77";

describe("User-confirmed Photo Groups", () => {
  it("takes over a failed group before a Document exists without creating member Documents or consuming AI", async () => {
    const owner = await administratorWithCompany();
    const gateway = await supabaseHttpGateway(inject("supabaseUrl"));
    const worker = testWorker(fakeAiProvider(), undefined, undefined, { system: systemClient(gateway.url) });
    await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai });
    const groupId = randomUUID();
    const selection = selectUploadFiles([{ fileName: "first.heic", bytes: heicFixture() }, { fileName: "second.png", bytes: fixtureFile("receipt.png") }]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    for (const file of selection.files) expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...file })).ok).toBe(true);
    await finishUploadBatch(owner.client, batch.value.id);
    // Only the Storage transport fails; original and normalized bytes remain intact.
    gateway.unavailable(true, "/storage/");
    expect((await worker.runJobsConcurrently()).length).toBeGreaterThan(0);
    gateway.unavailable(false);
    expect(await getDocument(owner.client, owner.companyId, groupId)).toBeNull();
    const input = { companyId: owner.companyId, groupId, mode: "manual" as const };
    expect(await recoverPhotoGroup(owner.client, worker.jobs, input)).toEqual({ ok: true, value: { id: groupId } });
    expect(await recoverPhotoGroup(owner.client, worker.jobs, input)).toEqual({ ok: true, value: { id: groupId } });
    expect(await worker.runJobsConcurrently()).toEqual([]);
    expect((await listCompanyDocuments(owner.client, owner.companyId)).map(document => [document.id, document.status])).toEqual([[groupId, "needs_review"]]);
    expect(await listExtractionVersions(owner.client, owner.companyId, groupId)).toEqual([]);
    expect(await getCompanyAiProcessingAllowance(owner.client, owner.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
    const group = await getPhotoGroup(owner.client, owner.companyId, groupId);
    expect(group?.sourceFileIds).toEqual(selection.files.map(file => file.sourceFileId));
    expect((await PDFDocument.load((await readPhotoGroupBasis(owner.client, owner.companyId, groupId))!.bytes)).getPageCount()).toBe(2);
    for (const file of selection.files) expect((await readSourceFile(owner.client, owner.companyId, file.sourceFileId))?.bytes).toEqual(file.bytes);
    expect(await listAuditEvents(owner.client, owner.organizationId)).toContainEqual(expect.objectContaining({ action: "photo_group.manual_review_requested", actorUserId: owner.userId, targetId: groupId }));
    gateway.close();
  });
  it.each(["late success", "late failure"])("manual group takeover rejects %s from a superseded preparation worker", async outcome => {
    const owner = await administratorWithCompany(), gateway = await supabaseHttpGateway(inject("supabaseUrl"));
    const worker = testWorker(fakeAiProvider(), undefined, undefined, { system: systemClient(gateway.url) });
    await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai });
    const groupId = randomUUID();
    const selection = selectUploadFiles([{ fileName: "first.heic", bytes: heicFixture() }, { fileName: "second.png", bytes: fixtureFile("receipt.png") }]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    for (const file of selection.files) expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...file })).ok).toBe(true);
    await finishUploadBatch(owner.client, batch.value.id);
    const held = gateway.holdNext("/storage/");
    const old = worker.runNextJob();
    await held.started;
    expect(await recoverPhotoGroup(owner.client, worker.jobs, { companyId: owner.companyId, groupId, mode: "manual" })).toEqual({ ok: true, value: { id: groupId } });
    if (outcome === "late failure") gateway.unavailable(true, "/storage/");
    held.release();
    await old;
    gateway.unavailable(false);
    expect(await worker.runJobsConcurrently()).toEqual([]);
    expect((await getDocument(owner.client, owner.companyId, groupId))?.status).toBe("needs_review");
    expect(await listExtractionVersions(owner.client, owner.companyId, groupId)).toEqual([]);
    expect((await listCompanyDocuments(owner.client, owner.companyId)).map(document => document.id)).toEqual([groupId]);
    expect((await getPhotoGroup(owner.client, owner.companyId, groupId))?.preparation).toEqual({ mode: "manual", status: "ready", failure: null });
    expect(await getCompanyAiProcessingAllowance(owner.client, owner.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
    gateway.close();
  });

  it("retries a temporary basis outage and lost queue acknowledgement as one successful Extraction", async () => {
    const owner = await administratorWithCompany(), gateway = await supabaseHttpGateway(inject("supabaseUrl"));
    const worker = testWorker(fakeAiProvider(), undefined, undefined, { system: systemClient(gateway.url) });
    await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai });
    const groupId = randomUUID(), selection = selectUploadFiles([{ fileName: "first.png", bytes: fixtureFile("receipt.png") }, { fileName: "second.heif", bytes: rotatedHeicFixture() }]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    for (const file of selection.files) expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...file })).ok).toBe(true);
    await finishUploadBatch(owner.client, batch.value.id);
    gateway.unavailable(true, `/storage/v1/object/source-files/${owner.companyId}/${selection.files[0].sourceFileId}/group/basis.pdf`);
    expect((await worker.runJobsConcurrently()).length).toBeGreaterThan(0);
    gateway.unavailable(false);
    expect((await systemClient().storage.from("source-files").list(`${owner.companyId}/${selection.files[0].sourceFileId}/group`)).data?.map(object => object.name)).toEqual(["1.png", "2.png"]);
    const input = { companyId: owner.companyId, groupId, mode: "retry" as const };
    await expect(recoverPhotoGroup(owner.client, { async send(job) { await worker.jobs.send(job); throw new Error("Lost queue acknowledgement"); } }, input)).rejects.toThrow("Lost queue acknowledgement");
    expect(await recoverPhotoGroup(owner.client, worker.jobs, input)).toEqual({ ok: true, value: { id: groupId } });
    expect(await worker.runJobsConcurrently()).toEqual([]);
    expect((await listCompanyDocuments(owner.client, owner.companyId)).map(document => document.id)).toEqual([groupId]);
    expect(await listExtractionVersions(owner.client, owner.companyId, groupId)).toHaveLength(1);
    expect(await getCompanyAiProcessingAllowance(owner.client, owner.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
    expect((await getPhotoGroup(owner.client, owner.companyId, groupId))?.sourceFileIds).toEqual(selection.files.map(file => file.sourceFileId));
    expect(await recoverPhotoGroup(owner.client, worker.jobs, input)).toEqual({ ok: false, error: "source_already_resolved" });
    gateway.close();
  });

  it("uses ordinary Document takeover and explicit AI retry after grouped Extraction failure without changing prior evidence", async () => {
    const owner = await administratorWithCompany(); let unavailable = true;
    const worker = testWorker(fakeAiProvider({ extract: () => { if (unavailable) throw new Error("Controlled AI failure"); return SAMPLE_EXTRACTION; } }));
    await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai });
    const groupId = randomUUID(), selection = selectUploadFiles([{ fileName: "first.heic", bytes: heicFixture() }, { fileName: "second.png", bytes: fixtureFile("receipt.png") }]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    for (const file of selection.files) expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...file })).ok).toBe(true);
    await finishUploadBatch(owner.client, batch.value.id);
    expect((await worker.runJobsConcurrently()).length).toBeGreaterThan(0);
    const input = { companyId: owner.companyId, documentId: groupId };
    expect((await getDocument(owner.client, owner.companyId, groupId))?.status).toBe("failed");
    const before = await readPhotoGroupBasis(owner.client, owner.companyId, groupId);
    expect(await getCompanyAiProcessingAllowance(owner.client, owner.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
    expect(await startManualDocumentReview(owner.client, input)).toEqual({ ok: true, value: null });
    expect(await correctDocument(owner.client, { ...input, basedOnVersion: 0, payload: { ...SAMPLE_EXTRACTION, documentNumber: "GROUP-MANUAL" } })).toEqual({ ok: true, value: { version: 1 } });
    const historical = (await listExtractionVersions(owner.client, owner.companyId, groupId))[0];
    unavailable = false;
    expect(await reprocessDocument(owner.client, worker.jobs, { ...input, confirmed: true })).toEqual({ ok: true, value: null });
    expect(await worker.runJobsConcurrently()).toEqual([]);
    const versions = await listExtractionVersions(owner.client, owner.companyId, groupId);
    expect(versions.map(version => version.author.kind)).toEqual(["user", "ai"]);
    expect(versions[0]).toEqual(historical);
    expect(await getCompanyAiProcessingAllowance(owner.client, owner.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
    expect((await listCompanyDocuments(owner.client, owner.companyId)).map(document => document.id)).toEqual([groupId]);
    expect((await readPhotoGroupBasis(owner.client, owner.companyId, groupId))?.bytes).toEqual(before?.bytes);
  });

  it("removes every group object and refuses a late Storage upload after takeover and batch deletion", async () => {
    const owner = await administratorWithCompany(), gateway = await supabaseHttpGateway(inject("supabaseUrl"));
    const worker = testWorker(fakeAiProvider(), undefined, undefined, { system: systemClient(gateway.url) });
    const groupId = randomUUID(), selection = selectUploadFiles([{ fileName: "first.heic", bytes: heicFixture() }, { fileName: "second.png", bytes: fixtureFile("receipt.png") }]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    for (const file of selection.files) expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...file })).ok).toBe(true);
    await finishUploadBatch(owner.client, batch.value.id);
    const anchor = selection.files[0].sourceFileId;
    const held = gateway.holdNext(`/storage/v1/object/source-files/${owner.companyId}/${anchor}/group/1.png`);
    const old = worker.runNextJob(); await held.started;
    expect(await recoverPhotoGroup(owner.client, worker.jobs, { companyId: owner.companyId, groupId, mode: "manual" })).toEqual({ ok: true, value: { id: groupId } });
    expect(await worker.runJobsConcurrently()).toEqual([]);
    expect((await getDocument(owner.client, owner.companyId, groupId))?.status).toBe("needs_review");
    expect(await deleteUploadBatch(owner.client, { companyId: owner.companyId, batchId: batch.value.id })).toEqual({ ok: true, value: null });
    held.release(); await old;
    expect(await getPhotoGroup(owner.client, owner.companyId, groupId)).toBeNull();
    expect(await listCompanyDocuments(owner.client, owner.companyId)).toEqual([]);
    const storage = systemClient().storage.from("source-files");
    for (const file of selection.files) expect((await storage.download(`${owner.companyId}/${file.sourceFileId}`)).error).not.toBeNull();
    expect((await storage.download(`${owner.companyId}/${anchor}/normalized.jpeg`)).error).not.toBeNull();
    expect((await storage.list(`${owner.companyId}/${anchor}/group`)).data).toEqual([]);
    for (const leaf of ["1.png", "2.png", "basis.pdf"]) expect((await storage.download(`${owner.companyId}/${anchor}/group/${leaf}`)).error).not.toBeNull();
    gateway.close();
  });

  it("rechecks foreign, revoked and MFA-restricted access at group recovery and direct RPC", async () => {
    const owner = await administratorWithCompany(), member = await companyMember(owner), foreign = await administratorWithCompany(), worker = testWorker();
    const groupId = randomUUID(), selection = selectUploadFiles([{ fileName: "first.png", bytes: fixtureFile("receipt.png") }, { fileName: "second.heic", bytes: heicFixture() }]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    for (const file of selection.files) expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...file })).ok).toBe(true);
    const input = { companyId: owner.companyId, groupId, mode: "manual" as const };
    expect(await getPhotoGroup(foreign.client, owner.companyId, groupId)).toBeNull();
    expect((await foreign.client.from("photo_group").select("*").eq("id", groupId)).data).toEqual([]);
    expect(await recoverPhotoGroup(foreign.client, worker.jobs, input)).toEqual({ ok: false, error: "forbidden" });
    expect((await foreign.client.rpc("recover_photo_group", { target_group_id: groupId, recovery_mode: "manual" })).error?.code).toBe("42501");
    // Retained identity reservations are internal metadata. The real authenticated
    // role cannot read or modify them, including under another native user's id.
    const database = new DatabaseClient({ connectionString: inject("databaseUrl") }); await database.connect();
    try {
      for (const sql of ["select * from private.photo_group_source_reservation where source_file_id=$1", "update private.photo_group_source_reservation set group_id=group_id where source_file_id=$1"]) {
        await database.query("begin");
        await database.query("set local role authenticated");
        await database.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: foreign.userId, role: "authenticated" })]);
        await expect(database.query(sql, [selection.files[0].sourceFileId])).rejects.toMatchObject({ code: "42501" });
        await database.query("rollback");
      }
    } finally { await database.end(); }
    expect(await recoverPhotoGroup(member.client, worker.jobs, input)).toEqual({ ok: true, value: { id: groupId } });
    const membership = (await listMemberships(owner.client, { organizationId: owner.organizationId, companyId: owner.companyId })).find(item => item.userId === member.userId)!;
    expect(await removeMembership(owner.client, membership.id)).toEqual({ ok: true, value: null });
    expect(await recoverPhotoGroup(member.client, worker.jobs, input)).toEqual({ ok: false, error: "forbidden" });
    expect((await member.client.rpc("recover_photo_group", { target_group_id: groupId, recovery_mode: "manual" })).error?.code).toBe("42501");
    expect((await setOrganizationMfaRequired(owner.client, { organizationId: owner.organizationId, required: true })).ok).toBe(true);
    expect(await recoverPhotoGroup(owner.client, worker.jobs, input)).toEqual({ ok: false, error: "forbidden" });
    expect((await owner.client.rpc("recover_photo_group", { target_group_id: groupId, recovery_mode: "manual" })).error?.code).toBe("42501");
  });

  it("refuses tenant uploads into a completed group basis namespace", async () => {
    const owner = await administratorWithCompany(), worker = testWorker();
    const groupId = randomUUID(), selection = selectUploadFiles([{ fileName: "first.png", bytes: fixtureFile("receipt.png") }, { fileName: "second.heic", bytes: heicFixture() }]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    for (const file of selection.files) expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...file })).ok).toBe(true);
    await finishUploadBatch(owner.client, batch.value.id);
    expect(await worker.runJobsConcurrently()).toEqual([]);
    const forged = await owner.client.storage.from("source-files").upload(`${owner.companyId}/${selection.files[0].sourceFileId}/group/99.png`, fixtureFile("receipt.png"), { contentType: "image/png" });
    expect(forged.error).not.toBeNull();
    expect((await getPhotoGroup(owner.client, owner.companyId, groupId))?.basis?.pages).toHaveLength(2);
  });

  it("retains the grouped Document Period Lock for manual recovery, AI retry and deletion", async () => {
    const owner = await administratorWithCompany(), worker = testWorker();
    await knownSupplierFixture(owner);
    const groupId = randomUUID(), selection = selectUploadFiles([{ fileName: "first.heic", bytes: heicFixture() }, { fileName: "second.png", bytes: fixtureFile("receipt.png") }]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    for (const file of selection.files) expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...file })).ok).toBe(true);
    await finishUploadBatch(owner.client, batch.value.id);
    expect(await recoverPhotoGroup(owner.client, worker.jobs, { companyId: owner.companyId, groupId, mode: "manual" })).toEqual({ ok: true, value: { id: groupId } });
    expect(await worker.runJobsConcurrently()).toEqual([]);
    const input = { companyId: owner.companyId, documentId: groupId };
    expect(await correctDocument(owner.client, { ...input, basedOnVersion: 0, payload: { ...SAMPLE_EXTRACTION, taxPointDate: "2026-11-01", claimEligibility: { period: "2026-11", origin: "user", confirmed: true } } })).toEqual({ ok: true, value: { version: 1 } });
    expect(await approveDocument(owner.client, { ...input, version: 1 })).toEqual({ ok: true, value: null });
    expect((await setCurrentReportingYear(owner.client, { companyId: owner.companyId, year: 2026, filingFrequency: "monthly" })).ok).toBe(true);
    const report = { companyId: owner.companyId, period: "2026-11" };
    expect((await generateVatReport(owner.client, report)).ok).toBe(true);
    expect(await finalizeVatReport(owner.client, { ...report, confirmed: true })).toEqual({ ok: true, value: null });
    expect(await recoverPhotoGroup(owner.client, worker.jobs, { companyId: owner.companyId, groupId, mode: "manual" })).toEqual({ ok: false, error: "period_locked" });
    expect(await startManualDocumentReview(owner.client, input)).toEqual({ ok: false, error: "not_recoverable" });
    expect(await reprocessDocument(owner.client, worker.jobs, { ...input, confirmed: true })).toEqual({ ok: false, error: "period_locked" });
    expect(await deleteUploadBatch(owner.client, { companyId: owner.companyId, batchId: batch.value.id })).toEqual({ ok: false, error: "period_locked" });
  });

  it("waits for every frozen original while the batch is open and preserves a manual group request", async () => {
    const owner = await administratorWithCompany(), worker = testWorker();
    const groupId = randomUUID(), selection = selectUploadFiles([{ fileName: "first.heic", bytes: heicFixture() }, { fileName: "second.png", bytes: fixtureFile("receipt.png") }]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...selection.files[0] })).ok).toBe(true);
    const input = { companyId: owner.companyId, groupId, mode: "manual" as const };
    expect(await recoverPhotoGroup(owner.client, worker.jobs, input)).toEqual({ ok: true, value: { id: groupId } });
    expect(await worker.runJobsConcurrently()).toEqual([]);
    expect(await getDocument(owner.client, owner.companyId, groupId)).toBeNull();
    expect((await getPhotoGroup(owner.client, owner.companyId, groupId))?.basis).toBeNull();
    expect((await getUploadBatch(owner.client, owner.companyId, batch.value.id))?.outcome).toBe("processing");
    expect((await getUploadBatch(owner.client, owner.companyId, batch.value.id))?.uploadFinishedAt).toBeNull();
    expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...selection.files[1] })).ok).toBe(true);
    await finishUploadBatch(owner.client, batch.value.id);
    expect(await worker.runJobsConcurrently()).toEqual([]);
    expect((await listCompanyDocuments(owner.client, owner.companyId)).map(document => [document.id, document.status])).toEqual([[groupId, "needs_review"]]);
    expect(await getCompanyAiProcessingAllowance(owner.client, owner.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
  });

  it("refuses recovery when only a non-anchor member belongs to a retained locked Source snapshot", async () => {
    const owner = await administratorWithCompany(), worker = testWorker();
    const groupId = randomUUID(), selection = selectUploadFiles([{ fileName: "first.heic", bytes: heicFixture() }, { fileName: "second.png", bytes: fixtureFile("receipt.png") }]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    for (const file of selection.files) expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...file })).ok).toBe(true);
    const second = (await getSourceFile(owner.client, owner.companyId, selection.files[1].sourceFileId))!;
    const period = pragueDate(second.uploadedAt).slice(0, 7);
    expect((await setCurrentReportingYear(owner.client, { companyId: owner.companyId, year: Number(period.slice(0, 4)), filingFrequency: "monthly" })).ok).toBe(true);
    expect((await generateVatReport(owner.client, { companyId: owner.companyId, period })).ok).toBe(true);
    const report = (await getVatReport(owner.client, owner.companyId, period))!;
    // A restored historical snapshot can name any source. This fixture locks
    // only the non-anchor; assertions use the normal user commands and query.
    const database = new DatabaseClient({ connectionString: inject("databaseUrl") }); await database.connect();
    try {
      await database.query("update public.vat_report set result=jsonb_set(result,'{sourceFilesReadinessSource}',jsonb_build_array(jsonb_build_object('sourceFileId',$2::text))) where id=$1", [report.id, second.id]);
      await database.query("insert into public.period_lock(company_id,organization_id,period,vat_report_id,locked_by) values($1,$2,$3,$4,$5)", [owner.companyId, owner.organizationId, period, report.id, owner.userId]);
    } finally { await database.end(); }
    const before = await getVatReport(owner.client, owner.companyId, period);
    for (const mode of ["manual", "retry"] as const) expect(await recoverPhotoGroup(owner.client, worker.jobs, { companyId: owner.companyId, groupId, mode })).toEqual({ ok: false, error: "period_locked" });
    expect((await owner.client.rpc("recover_photo_group", { target_group_id: groupId, recovery_mode: "manual" })).error?.hint).toBe("period_locked");
    expect(await getDocument(owner.client, owner.companyId, groupId)).toBeNull();
    expect(await getVatReport(owner.client, owner.companyId, period)).toEqual(before);
  });

  it("refuses an undecodable original with valid identity and metadata without offering substitute evidence", async () => {
    const owner = await administratorWithCompany(), worker = testWorker();
    const invalid = fixtureFile("receipt.png").slice(); invalid[41] ^= 255;
    const groupId = randomUUID(), selection = selectUploadFiles([{ fileName: "bad-pixels.png", bytes: invalid }, { fileName: "second.heic", bytes: heicFixture() }]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    for (const file of selection.files) expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...file })).ok).toBe(true);
    await finishUploadBatch(owner.client, batch.value.id);
    expect((await worker.runJobsConcurrently()).length).toBeGreaterThan(0);
    expect(await getDocument(owner.client, owner.companyId, groupId)).toBeNull();
    for (const mode of ["manual", "retry"] as const) expect(await recoverPhotoGroup(owner.client, worker.jobs, { companyId: owner.companyId, groupId, mode })).toEqual({ ok: false, error: "group_evidence_unavailable" });
    expect((await readSourceFile(owner.client, owner.companyId, selection.files[0].sourceFileId))?.bytes).toEqual(invalid);
  });

  it.each(["original", "normalization"] as const)("refuses a late %s upload after deletion before any Source row exists", async kind => {
    const owner = await administratorWithCompany(), gateway = await supabaseHttpGateway(inject("supabaseUrl")), worker = testWorker();
    const proxy = asUserClient(createClient(gateway.url, inject("supabaseAnonKey"), { auth: { persistSession: false, autoRefreshToken: false } }));
    const session = await owner.client.auth.getSession();
    if (!session.data.session) throw new Error("Native Auth session missing");
    expect((await proxy.auth.setSession(session.data.session)).error).toBeNull();
    const groupId = randomUUID(), selection = selectUploadFiles([{ fileName: "first.heic", bytes: heicFixture() }, { fileName: "second.png", bytes: fixtureFile("receipt.png") }]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    const sourceId = selection.files[0].sourceFileId;
    const held = gateway.holdNext(`/storage/v1/object/source-files/${owner.companyId}/${sourceId}${kind === "normalization" ? "/normalized.jpeg" : ""}`);
    const uploading = uploadSourceFile(proxy, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...selection.files[0] });
    await held.started;
    expect(await getSourceFile(owner.client, owner.companyId, sourceId)).toBeNull();
    await finishUploadBatch(owner.client, batch.value.id);
    expect(await deleteUploadBatch(owner.client, { companyId: owner.companyId, batchId: batch.value.id })).toEqual({ ok: true, value: null });
    held.release();
    expect(await uploading).toEqual({ ok: false, error: "forbidden" });
    const storage = systemClient().storage.from("source-files");
    expect((await storage.download(`${owner.companyId}/${sourceId}`)).error).not.toBeNull();
    expect((await storage.download(`${owner.companyId}/${sourceId}/normalized.jpeg`)).error).not.toBeNull();
    expect((await storage.list(`${owner.companyId}/${sourceId}`)).data).toEqual([]);
    const replacementGroup = randomUUID();
    expect(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId: replacementGroup })) })).toEqual({ ok: false, error: "invalid_choice" });
    expect(await listCompanyDocuments(owner.client, owner.companyId)).toEqual([]);
    gateway.close();
  });

  it("preserves mixed JPEG/PNG/HEIC/HEIF originals and extracts the ordered persisted normalized basis once", async () => {
    const owner = await administratorWithCompany();
    const groupId = randomUUID();
    const selection = selectUploadFiles([
      { fileName: "first.png", bytes: fixtureFile("receipt.png") },
      { fileName: "second.heic", bytes: heicFixture() },
      { fileName: "third.jpg", bytes: new Uint8Array(await sharp({ create: { width: 80, height: 120, channels: 3, background: "#ff0000" } }).jpeg().toBuffer()) },
      { fileName: "fourth.heif", bytes: rotatedHeicFixture() },
    ]);
    const worker = testWorker(fakeAiProvider({ split: () => { throw new Error("Human boundaries must bypass AI Split"); }, extract: input => {
      expect(input.pageCount).toBe(4);
      expect(input.pageImages?.map(page => createHash("sha256").update(page.bytes).digest("hex")).filter((_, index) => index === 1 || index === 3)).toEqual([
        "9339c93194e6e0fd13c075a0d9a8351d3ff52f186af16c16d4fc09ef827539a1",
        "e8e79f3d7576bb64bab656481dd2cceaa72bf6831da8b0470379dd764120da43",
      ]);
      return { ...SAMPLE_EXTRACTION, sourceLocations: [{ fieldPath: "documentNumber", kind: "page", page: 4, x: 0.1, y: 0.2, width: 0.3, height: 0.1 }] };
    } }));
    await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai });
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 4, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    for (const file of [...selection.files].reverse()) expect(await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...file })).toEqual({ ok: true, value: { id: file.sourceFileId } });
    await finishUploadBatch(owner.client, batch.value.id);
    expect(await worker.runJobsConcurrently()).toEqual([]);
    const group = await getPhotoGroup(owner.client, owner.companyId, groupId);
    expect(group?.basis?.pages.map(page => page.sourceFileId)).toEqual(selection.files.map(file => file.sourceFileId));
    expect((await listCompanyDocuments(owner.client, owner.companyId)).map(document => document.id)).toEqual([groupId]);
    const versions = await listExtractionVersions(owner.client, owner.companyId, groupId);
    expect(versions).toHaveLength(1);
    expect(versions[0].payload.sourceEvidence?.basis).toEqual({ kind: "photo_group", format: "pdf", sha256: group?.basis?.sha256, groupId });
    expect(versions[0].payload.sourceEvidence?.fields.documentNumber.locations).toEqual([{ kind: "page", page: 4, x: 0.1, y: 0.2, width: 0.3, height: 0.1 }]);
    expect((await PDFDocument.load((await readDocumentPages(owner.client, owner.companyId, groupId))!.bytes)).getPageCount()).toBe(4);
    for (const file of selection.files) expect((await readSourceFile(owner.client, owner.companyId, file.sourceFileId))?.bytes).toEqual(file.bytes);
    for (const [index, expected] of [[1, "5a1dd9a99bd1a6d750a131e9a7148f70be5d95475861b3b57bcb44668e6f6cc8"], [3, "268da1a5dfca47126246de862aedef33128afaddd56265457d5dea20beffaf22"]] as const) {
      const derivative = await readSourceFileDerivative(owner.client, owner.companyId, selection.files[index].sourceFileId);
      expect(derivative?.bytes.length).toBe(664);
      expect(createHash("sha256").update(derivative!.bytes).digest("hex")).toBe(expected);
      expect(group?.basis?.pages[index]).toMatchObject({ normalizedDerivative: { format: "jpeg", sha256: expected, byteSize: 664 } });
    }
    expect(await getCompanyAiProcessingAllowance(owner.client, owner.companyId)).toEqual({ ok: true, value: { used: 1, allowance: 50, waitingDocuments: 0 } });
    expect((await getUploadBatch(owner.client, owner.companyId, batch.value.id))?.actualFileCount).toBe(4);
    const exported = await exportCompanyData(owner.client, worker.jobs, { companyId: owner.companyId });
    if (!exported.ok) throw new Error(exported.error);
    const archive = unzipSync(exported.value.bytes);
    expect(JSON.parse(strFromU8(archive[`photo-groups/${groupId}/manifest.json`]))).toEqual(group);
    for (const file of selection.files) expect(archive[`source-files/${file.sourceFileId}/${file.fileName}`]).toEqual(file.bytes);
    for (const index of [1, 3]) expect(archive[`source-files/${selection.files[index].sourceFileId}/normalized.jpeg`]).toEqual((await readSourceFileDerivative(owner.client, owner.companyId, selection.files[index].sourceFileId))?.bytes);
    for (const page of group!.basis!.pages) expect(createHash("sha256").update(archive[`photo-groups/${groupId}/${page.page}.png`]).digest("hex")).toBe(page.sha256);
    expect(archive[`photo-groups/${groupId}/basis.pdf`]).toEqual((await readDocumentPages(owner.client, owner.companyId, groupId))?.bytes);
    expect(await worker.runJobs()).toEqual([]);
    expect(await getCompanyDataExportStatus(owner.client, { companyId: owner.companyId, exportId: exported.value.exportId })).toEqual({ ok: true, value: "completed" });
    const storage = systemClient().storage.from("source-files");
    const missingNormalization = `${owner.companyId}/${selection.files[1].sourceFileId}/normalized.jpeg`;
    expect((await storage.remove([missingNormalization])).error).toBeNull();
    expect(await exportCompanyData(owner.client, worker.jobs, { companyId: owner.companyId })).toEqual({ ok: false, error: "export_failed" });
    expect((await getPhotoGroup(owner.client, owner.companyId, groupId))?.basis).toEqual(group?.basis);
    expect(await deleteUploadBatch(owner.client, { companyId: owner.companyId, batchId: batch.value.id })).toEqual({ ok: true, value: null });
    for (const file of selection.files) expect((await storage.download(`${owner.companyId}/${file.sourceFileId}`)).error).not.toBeNull();
    for (const file of [selection.files[1], selection.files[3]]) expect((await storage.download(`${owner.companyId}/${file.sourceFileId}/normalized.jpeg`)).error).not.toBeNull();
    for (const leaf of ["basis.pdf", "1.png", "2.png", "3.png", "4.png"]) expect((await storage.download(`${owner.companyId}/${selection.files[0].sourceFileId}/group/${leaf}`)).error).not.toBeNull();
  });

  it.each(["missing", "corrupt", "stale", "original"] as const)("refuses a %s stored HEIC representation without regenerating evidence", async failure => {
    const owner = await administratorWithCompany(), worker = testWorker();
    const groupId = randomUUID();
    const selection = selectUploadFiles([{ fileName: "page.heic", bytes: heicFixture() }, { fileName: "other.png", bytes: fixtureFile("receipt.png") }]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    for (const file of selection.files) expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...file })).ok).toBe(true);
    const storage = systemClient().storage.from("source-files");
    const path = `${owner.companyId}/${selection.files[0].sourceFileId}${failure === "original" ? "" : "/normalized.jpeg"}`;
    if (failure === "missing") expect((await storage.remove([path])).error).toBeNull();
    else {
      let bytes = failure === "original" ? heicFixture() : (await readSourceFileDerivative(owner.client, owner.companyId, selection.files[0].sourceFileId))!.bytes;
      if (failure === "stale") {
        const ordinary = await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, fileName: "rotated.heif", bytes: rotatedHeicFixture() });
        if (!ordinary.ok) throw new Error(ordinary.error);
        bytes = (await readSourceFileDerivative(owner.client, owner.companyId, ordinary.value.id))!.bytes;
      } else { bytes = bytes.slice(); bytes[bytes.length - 1] ^= 1; }
      expect((await storage.upload(path, bytes, { upsert: true, contentType: failure === "original" ? "image/heic" : "image/jpeg" })).error).toBeNull();
    }
    await finishUploadBatch(owner.client, batch.value.id);
    const errors = await worker.runJobsConcurrently();
    expect(errors.length).toBeGreaterThan(0);
    if (failure !== "missing") expect(errors).toContainEqual(expect.objectContaining({ message: failure === "original" ? "Photo Group original checksum mismatch" : "Photo Group normalization checksum mismatch" }));
    expect((await getPhotoGroup(owner.client, owner.companyId, groupId))?.basis).toBeNull();
    expect(await getDocument(owner.client, owner.companyId, groupId)).toBeNull();
    expect((await getUploadBatch(owner.client, owner.companyId, batch.value.id))?.outcome).toBe("failure");
    for (const mode of ["manual", "retry"] as const) expect(await recoverPhotoGroup(owner.client, worker.jobs, { companyId: owner.companyId, groupId, mode })).toEqual({ ok: false, error: "group_evidence_unavailable" });
    if (failure === "missing") expect((await storage.download(path)).error).not.toBeNull();
    if (failure !== "original") expect((await readSourceFile(owner.client, owner.companyId, selection.files[0].sourceFileId))?.bytes).toEqual(heicFixture());
  });

  it("enforces mixed original totals through direct writes and the final PDF byte limit after normalization", async () => {
    const { promotedSuperAdministrator } = await import("./support/platform");
    const { getUploadLimits } = await import("@/application/source-files");
    const { setPlatformUploadLimits } = await import("@/application/platform-administration");
    const owner = await administratorWithCompany(), platform = await promotedSuperAdministrator("Mixed Photo Group limits"), worker = testWorker();
    const previous = await getUploadLimits(platform.client);
    const groupId = randomUUID();
    const selection = selectUploadFiles([{ fileName: "page.heic", bytes: heicFixture() }, { fileName: "other.png", bytes: fixtureFile("receipt.png") }]);
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    try {
      expect((await setPlatformUploadLimits(platform.client, { ...previous, maxFileBytes: 1400 })).ok).toBe(true);
      expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...selection.files[0] })).ok).toBe(true);
      expect(await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...selection.files[1] })).toEqual({ ok: false, error: "file_too_large" });
      expect((await owner.client.from("source_file").insert({ id: selection.files[1].sourceFileId, organization_id: owner.organizationId, company_id: owner.companyId, upload_batch_id: batch.value.id, file_name: "other.png", format: "png", byte_size: selection.files[1].bytes.length, sha256: selection.selectedFiles[1].sha256, page_count: 1 })).error?.hint).toBe("file_too_large");
      expect((await setPlatformUploadLimits(platform.client, { ...previous, maxFileBytes: 1500 })).ok).toBe(true);
      expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...selection.files[1] })).ok).toBe(true);
      await finishUploadBatch(owner.client, batch.value.id);
      expect(await worker.runJobsConcurrently()).toContainEqual(expect.objectContaining({ message: "Photo Group PDF basis exceeds platform limit" }));
      expect((await getPhotoGroup(owner.client, owner.companyId, groupId))?.basis).toBeNull();
      expect(await getDocument(owner.client, owner.companyId, groupId)).toBeNull();
    } finally { await setPlatformUploadLimits(platform.client, previous); }
  });
  it("preserves ordered originals and sends one stored basis to one Extraction, despite AI Split boundaries", async () => {
    const owner = await administratorWithCompany();
    const groupId = randomUUID(), batchId = randomUUID(), first = randomUUID(), second = randomUUID();
    const selectedFiles = [{ id: first, sha256: jpegHash, groupId }, { id: second, sha256: pngHash, groupId }];
    const worker = testWorker(fakeAiProvider({ split: () => { throw new Error("Human boundaries must bypass AI Split"); }, extract: input => {
      expect(input.format).toBe("pdf");
      expect(input.pageCount).toBe(2);
      expect(input.pageImages).toHaveLength(2);
      return { ...SAMPLE_EXTRACTION, sourceLocations: [{ fieldPath: "documentNumber", kind: "page", page: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.1 }] };
    } }));
    await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai });
    expect(await beginUploadBatch(owner.client, { companyId: owner.companyId, batchId, fileCount: 2, selectedFiles })).toEqual({ ok: true, value: { id: batchId } });
    for (const [id, fileName] of [[second, "receipt.png"], [first, "receipt.jpg"]]) {
      expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId, sourceFileId: id, fileName, bytes: fileName.endsWith("jpg") ? await sharp({ create: { width: 80, height: 120, channels: 3, background: "#ff0000" } }).jpeg().toBuffer() : fixtureFile(fileName) })).ok).toBe(true);
    }
    await finishUploadBatch(owner.client, batchId);
    expect(await worker.runJobsConcurrently()).toEqual([]);
    const batch = await getUploadBatch(owner.client, owner.companyId, batchId);
    expect(batch?.actualFileCount).toBe(2);
    expect(batch?.sourceFiles.flatMap(source => source.documents)).toHaveLength(1);
    expect(batch?.outcome).toBe("success");
    expect((await getDocument(owner.client, owner.companyId, groupId))?.status).toBe("needs_review");
    const versions = await listExtractionVersions(owner.client, owner.companyId, groupId);
    expect(versions).toHaveLength(1);
    const group = await getPhotoGroup(owner.client, owner.companyId, groupId);
    expect(group?.sourceFileIds).toEqual([first, second]);
    expect(group?.createdBy).toBe(owner.userId);
    expect(group?.basis?.pages).toHaveLength(2);
    expect(await listAuditEvents(owner.client, owner.organizationId)).toContainEqual(expect.objectContaining({ action: "photo_group.confirmed", actorUserId: owner.userId, targetId: groupId }));
    expect(versions[0].payload.sourceEvidence?.basis).toEqual({ kind: "photo_group", format: "pdf", sha256: group?.basis?.sha256, groupId });
    expect(versions[0].payload.sourceEvidence?.fields.documentNumber.locations[0]).toEqual({ kind: "page", page: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.1 });
    expect((await readSourceFile(owner.client, owner.companyId, first))?.bytes).toEqual(new Uint8Array(await sharp({ create: { width: 80, height: 120, channels: 3, background: "#ff0000" } }).jpeg().toBuffer()));
    expect((await readSourceFile(owner.client, owner.companyId, second))?.bytes).toEqual(fixtureFile("receipt.png"));
    expect((await readDocumentPages(owner.client, owner.companyId, groupId))?.bytes).toEqual((await readPhotoGroupBasis(owner.client, owner.companyId, groupId))?.bytes);
    expect(await getCompanyAiProcessingAllowance(owner.client, owner.companyId)).toEqual({ ok: true, value: { used: 1, allowance: 50, waitingDocuments: 0 } });
    const exported = await exportCompanyData(owner.client, worker.jobs, { companyId: owner.companyId });
    if (!exported.ok) throw new Error(exported.error);
    expect(await worker.runJobs()).toEqual([]);
    expect(await getCompanyDataExportStatus(owner.client, { companyId: owner.companyId, exportId: exported.value.exportId })).toEqual({ ok: true, value: "completed" });
    const archive = unzipSync(exported.value.bytes);
    expect(JSON.parse(strFromU8(archive[`photo-groups/${groupId}/manifest.json`])).sourceFileIds).toEqual([first, second]);
    expect(archive[`photo-groups/${groupId}/basis.pdf`]).toEqual((await readPhotoGroupBasis(owner.client, owner.companyId, groupId))?.bytes);
    expect(archive[`photo-groups/${groupId}/1.png`]).toBeDefined();
    expect(archive[`photo-groups/${groupId}/2.png`]).toBeDefined();
    expect(archive[`source-files/${second}/receipt.png`]).toEqual(fixtureFile("receipt.png"));
    expect(archive[`source-files/${first}/receipt.jpg`]).toEqual((await readSourceFile(owner.client, owner.companyId, first))?.bytes);
    expect(await beginUploadBatch(owner.client, { companyId: owner.companyId, batchId, fileCount: 2, selectedFiles: [...selectedFiles].reverse() })).toEqual({ ok: false, error: "invalid_choice" });
  });
  it("refuses combined original bytes above the current limit before processing and keeps tenant decisions isolated", async () => {
    const { promotedSuperAdministrator } = await import("./support/platform");
    const { getUploadLimits } = await import("@/application/source-files");
    const { setPlatformUploadLimits } = await import("@/application/platform-administration");
    const owner = await administratorWithCompany(), foreign = await administratorWithCompany();
    const platform = await promotedSuperAdministrator("Photo Group limits");
    const previous = await getUploadLimits(platform.client);
    const groupId = randomUUID(), first = randomUUID(), second = randomUUID();
    const selectedFiles = [{ id: first, sha256: jpegHash, groupId }, { id: second, sha256: pngHash, groupId }];
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles });
    if (!batch.ok) throw new Error(batch.error);
    expect(await getPhotoGroup(foreign.client, owner.companyId, groupId)).toBeNull();
    expect((await foreign.client.from("photo_group").select("*").eq("id", groupId)).data).toEqual([]);
    expect((await foreign.client.from("photo_group").update({ source_file_ids: [second, first] }).eq("id", groupId)).error?.code).toBe("42501");
    expect((await owner.client.from("photo_group").update({ source_file_ids: [second, first] }).eq("id", groupId)).error?.code).toBe("42501");
    const reusedGroupId = randomUUID();
    expect(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selectedFiles.map(file => ({ ...file, groupId: reusedGroupId })) })).toEqual({ ok: false, error: "invalid_choice" });
    const worker = testWorker();
    try {
      const limitedGroup = randomUUID();
      const limitedSelection = [{ id: randomUUID(), sha256: jpegHash, groupId: limitedGroup }, { id: randomUUID(), sha256: pngHash, groupId: limitedGroup }];
      expect((await setPlatformUploadLimits(platform.client, { ...previous, maxFilePages: 1 })).ok).toBe(true);
      expect(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: limitedSelection })).toEqual({ ok: false, error: "too_many_pages" });
      expect((await owner.client.rpc("begin_upload_batch", { target_company_id: owner.companyId, selected_file_count: 2, selected_files: limitedSelection })).error?.hint).toBe("too_many_pages");
      expect((await setPlatformUploadLimits(platform.client, { ...previous, maxBatchFiles: 1 })).ok).toBe(true);
      expect(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: limitedSelection })).toEqual({ ok: false, error: "too_many_files" });
      expect((await setPlatformUploadLimits(platform.client, { ...previous, maxFileBytes: 350 })).ok).toBe(true);
      expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, sourceFileId: first, fileName: "red.jpg", bytes: await sharp({ create: { width: 80, height: 120, channels: 3, background: "#ff0000" } }).jpeg().toBuffer() })).ok).toBe(true);
      expect(await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, sourceFileId: second, fileName: "receipt.png", bytes: fixtureFile("receipt.png") })).toEqual({ ok: false, error: "file_too_large" });
      expect((await getPhotoGroup(owner.client, owner.companyId, groupId))?.basis).toBeNull();
    } finally { await setPlatformUploadLimits(platform.client, previous); }
    await finishUploadBatch(owner.client, batch.value.id);
    expect((await worker.runJobs()).length).toBeGreaterThan(0);
    expect(await deleteUploadBatch(owner.client, { companyId: owner.companyId, batchId: batch.value.id })).toEqual({ ok: true, value: null });
    expect((await owner.client.storage.from("source-files").download(`${owner.companyId}/${second}`)).error).not.toBeNull();
  });

  it("keeps a disabled-AI group as one manual Document and deletes its complete basis through the normal Batch lifecycle", async () => {
    const owner = await administratorWithCompany();
    const worker = testWorker();
    const groupId = randomUUID(), first = randomUUID(), second = randomUUID();
    const selection = [{ id: first, sha256: jpegHash, groupId }, { id: second, sha256: pngHash, groupId }];
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selection });
    if (!batch.ok) throw new Error(batch.error);
    for (const [sourceFileId, fileName, bytes] of [[first, "red.jpg", await sharp({ create: { width: 80, height: 120, channels: 3, background: "#ff0000" } }).jpeg().toBuffer()], [second, "receipt.png", fixtureFile("receipt.png")]] as const) {
      expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, sourceFileId, fileName, bytes })).ok).toBe(true);
    }
    await finishUploadBatch(owner.client, batch.value.id);
    expect(await worker.runJobsConcurrently()).toEqual([]);
    expect((await getDocument(owner.client, owner.companyId, groupId))?.status).toBe("needs_review");
    expect(await listExtractionVersions(owner.client, owner.companyId, groupId)).toEqual([]);
    expect((await getCompanyAiProcessingAllowance(owner.client, owner.companyId))).toEqual({ ok: true, value: { used: 0, allowance: 50, waitingDocuments: 0 } });
    expect(await splitDocument(owner.client, worker.jobs, { companyId: owner.companyId, documentId: groupId, splitAfterPage: 1 })).toEqual({ ok: false, error: "not_correctable" });
    expect(await deleteUploadBatch(owner.client, { companyId: owner.companyId, batchId: batch.value.id })).toEqual({ ok: true, value: null });
    expect(await getPhotoGroup(owner.client, owner.companyId, groupId)).toBeNull();
    expect(await getDocument(owner.client, owner.companyId, groupId)).toBeNull();
    for (const leaf of [first, second, `${first}/group/basis.pdf`, `${first}/group/1.png`, `${first}/group/2.png`]) {
      expect((await owner.client.storage.from("source-files").download(`${owner.companyId}/${leaf}`)).error).not.toBeNull();
    }
  });

  it("does not fabricate a basis or Document when an original photograph cannot be decoded", async () => {
    const owner = await administratorWithCompany(), worker = testWorker();
    const first = randomUUID(), second = randomUUID(), groupId = randomUUID();
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: [{ id: first, sha256: "9650f149d622055c4b495e65e9148ebfc5e61b1bb00e83538e76afe48c496eaf", groupId }, { id: second, sha256: pngHash, groupId }] });
    if (!batch.ok) throw new Error(batch.error);
    for (const [sourceFileId, fileName] of [[first, "receipt.jpg"], [second, "receipt.png"]]) expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, sourceFileId, fileName, bytes: fixtureFile(fileName) })).ok).toBe(true);
    await finishUploadBatch(owner.client, batch.value.id);
    expect((await worker.runJobsConcurrently()).length).toBeGreaterThan(0);
    expect((await getUploadBatch(owner.client, owner.companyId, batch.value.id))?.outcome).toBe("failure");
    expect((await getPhotoGroup(owner.client, owner.companyId, groupId))?.basis).toBeNull();
    expect(await listCompanyDocuments(owner.client, owner.companyId)).toEqual([]);
    expect((await readSourceFile(owner.client, owner.companyId, first))?.bytes).toEqual(fixtureFile("receipt.jpg"));
    expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, sourceFileId: first, fileName: "receipt.jpg", bytes: fixtureFile("receipt.jpg") })).ok).toBe(true);
    expect(await worker.runJobs()).toEqual([]);
    expect((await getUploadBatch(owner.client, owner.companyId, batch.value.id))?.outcome).toBe("failure");
  });

  it("preserves ordinary PDF processing beside the group and parks all Documents when allowance is exhausted", async () => {
    const { promotedSuperAdministrator } = await import("./support/platform");
    const { setCompanyAiProcessingAllowance } = await import("@/application/ai-processing-allowance");
    const owner = await administratorWithCompany(), platform = await promotedSuperAdministrator("Group allowance");
    const worker = testWorker();
    await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai });
    expect((await setCompanyAiProcessingAllowance(platform.client, worker.jobs, { companyId: owner.companyId, allowance: 0 })).ok).toBe(true);
    const groupId = randomUUID(), first = randomUUID(), second = randomUUID(), ordinary = randomUUID();
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 3, selectedFiles: [{ id: first, sha256: jpegHash, groupId }, { id: second, sha256: pngHash, groupId }, { id: ordinary, sha256: "79ae60b6a1040a3eaf64d441f2fa48f627a18d1e5c1ad831ba6919e9e9c663ea" }] });
    if (!batch.ok) throw new Error(batch.error);
    for (const [sourceFileId, fileName, bytes] of [[first, "red.jpg", await sharp({ create: { width: 80, height: 120, channels: 3, background: "#ff0000" } }).jpeg().toBuffer()], [second, "receipt.png", fixtureFile("receipt.png")], [ordinary, "two-invoices.pdf", fixtureFile("two-invoices.pdf")]] as const) {
      expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, sourceFileId, fileName, bytes })).ok).toBe(true);
    }
    await finishUploadBatch(owner.client, batch.value.id);
    expect(await worker.runJobsConcurrently()).toEqual([]);
    expect((await listCompanyDocuments(owner.client, owner.companyId)).map(document => document.status)).toEqual(["waiting_for_allowance", "waiting_for_allowance", "waiting_for_allowance"]);
    expect((await getUploadBatch(owner.client, owner.companyId, batch.value.id))?.actualFileCount).toBe(3);
    expect(await getCompanyAiProcessingAllowance(owner.client, owner.companyId)).toEqual({ ok: true, value: { used: 0, allowance: 0, waitingDocuments: 3 } });
    expect((await setCompanyAiProcessingAllowance(platform.client, worker.jobs, { companyId: owner.companyId, allowance: 3 })).ok).toBe(true);
    expect(await worker.runJobs()).toEqual([]);
    expect((await getDocument(owner.client, owner.companyId, groupId))?.lastPage).toBe(2);
    expect((await listCompanyDocuments(owner.client, owner.companyId)).map(document => document.status)).toEqual(["needs_review", "needs_review", "needs_review"]);
    expect(await getCompanyAiProcessingAllowance(owner.client, owner.companyId)).toEqual({ ok: true, value: { used: 3, allowance: 3, waitingDocuments: 0 } });
  });

  it("prepares every ordered original above a real PostgREST response cap without a false incomplete failure", async () => {
    const owner = await administratorWithCompany();
    const groupId = randomUUID();
    const worker = testWorker(fakeAiProvider({ extract: input => {
      expect(input.pageCount).toBe(4);
      expect(input.pageImages?.map(page => [page.width, page.height])).toEqual([[8, 12], [9, 13], [10, 14], [11, 15]]);
      return SAMPLE_EXTRACTION;
    } }));
    await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai });
    const selection = selectUploadFiles(await Promise.all(["#ff0000", "#00ff00", "#0000ff", "#000000"].map(async (background, index) => ({
      fileName: `page-${index + 1}.png`,
      bytes: new Uint8Array(await sharp({ create: { width: 8 + index, height: 12 + index, channels: 3, background } }).png().toBuffer()),
    }))));
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 4, selectedFiles: selection.selectedFiles.map(file => ({ ...file, groupId })) });
    if (!batch.ok) throw new Error(batch.error);
    const pendingFiles = [...selection.files].reverse();
    const first = pendingFiles.shift()!;
    expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...first })).ok).toBe(true);
    expect(await worker.runJobs()).toEqual([]);
    expect((await readSourceFile(owner.client, owner.companyId, first.sourceFileId))?.file.status).toBe("uploaded");
    for (const file of pendingFiles) expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.value.id, ...file })).ok).toBe(true);
    await finishUploadBatch(owner.client, batch.value.id);
    worker.releaseDelayedJobs();
    await withPostgrestRowLimit(2, companySourceFileRowLimitProbe(owner.client, owner.companyId), async () => {
      expect(await worker.runJobsConcurrently()).toEqual([]);
      expect((await getDocument(owner.client, owner.companyId, groupId))?.status).toBe("needs_review");
      const group = await getPhotoGroup(owner.client, owner.companyId, groupId);
      expect(group?.basis?.pages.map(page => page.sourceFileId)).toEqual(selection.files.map(file => file.sourceFileId));
      expect(group?.basis?.pages.map(page => [page.width, page.height])).toEqual([[8, 12], [9, 13], [10, 14], [11, 15]]);
      const stored = await readPhotoGroupBasis(owner.client, owner.companyId, groupId);
      expect((await PDFDocument.load(stored!.bytes)).getPageCount()).toBe(4);
      expect(await listExtractionVersions(owner.client, owner.companyId, groupId)).toHaveLength(1);
    });
    expect(await listCompanyDocuments(owner.client, owner.companyId)).toHaveLength(1);
    expect((await getUploadBatch(owner.client, owner.companyId, batch.value.id))?.outcome).toBe("success");
    expect(await getCompanyAiProcessingAllowance(owner.client, owner.companyId)).toEqual({ ok: true, value: { used: 1, allowance: 50, waitingDocuments: 0 } });
  });

});
