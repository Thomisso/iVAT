import { unzipSync, strFromU8 } from "fflate";
import { exportCompanyData, getCompanyDataExportStatus } from "@/application/company-deletion";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import sharp from "sharp";
import { listAuditEvents } from "@/application/audit";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { beginUploadBatch, finishUploadBatch, getUploadBatch, deleteUploadBatch } from "@/application/upload-batches";
import { uploadSourceFile, readSourceFile } from "@/application/source-files";
import { getDocument, listExtractionVersions, readDocumentPages, splitDocument, listCompanyDocuments } from "@/application/documents";
import { getPhotoGroup, readPhotoGroupBasis } from "@/application/photo-groups";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { administratorWithCompany, assignAiConfigurationFixture } from "./support/fixtures";
import { fixtureFile, selectUploadFiles } from "./support/files";
import { companySourceFileRowLimitProbe, withPostgrestRowLimit } from "./support/postgrest";
import { PDFDocument } from "pdf-lib";
import { testWorker } from "./support/worker";

const jpegHash = "0896be252af2407fd12029be53cc41ea9747e33613fb5702a0e8c5b39b1fc7c1";
const pngHash = "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77";

describe("User-confirmed Photo Groups", () => {
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
