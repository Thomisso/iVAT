import { describe, expect, it, vi } from "vitest";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { listAuditEvents } from "@/application/audit";
import { approveDocument, listCompanyDocuments, listExtractionVersions } from "@/application/documents";
import { finalizeVatReport, generateVatReport } from "@/application/vat-reports";
import { listSourceFiles, SOURCE_FILE_BUCKET, uploadSourceFile } from "@/application/source-files";
import {
  beginUploadBatch,
  deleteUploadBatch,
  finishUploadBatch,
  getUploadBatchDeletionPreview,
  getUploadBatch,
  listUploadNotifications,
} from "@/application/upload-batches";
import type { AppClient } from "@/application/client";
import { createCompany } from "@/application/companies";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
  companyDetails,
  companyMember,
} from "./support/fixtures";
import { fixtureFile, selectUploadFiles, selectFixtureFiles } from "./support/files";
import { systemClient, testWorker } from "./support/worker";

type TestWorker = ReturnType<typeof testWorker>;

async function finishedBatch(
  client: AppClient,
  worker: TestWorker,
  companyId: string,
  files: { fileName: string; fixture: Parameters<typeof fixtureFile>[0] }[] = [
    { fileName: "invoices.pdf", fixture: "two-invoices.pdf" },
    { fileName: "receipt.png", fixture: "receipt.png" },
  ],
) {
  const selection = selectUploadFiles(files.map((file) => ({ fileName: file.fileName, bytes: fixtureFile(file.fixture) })));
  const batch = await beginUploadBatch(client, { companyId, fileCount: files.length, selectedFiles: selection.selectedFiles });
  if (!batch.ok) throw new Error(batch.error);
  for (const file of selection.files) {
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      batchId: batch.value.id,
      ...file,
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
  }
  await finishUploadBatch(client, batch.value.id);
  expect(await worker.runJobs()).toEqual([]);
  return batch.value.id;
}

async function batchDocumentIds(client: AppClient, companyId: string, batchId: string) {
  const batch = await getUploadBatch(client, companyId, batchId);
  return batch?.sourceFiles.flatMap((source) => source.documents.map((document) => document.id)) ?? [];
}

async function storedObjectNames(companyId: string): Promise<string[]> {
  const storage = systemClient().storage.from(SOURCE_FILE_BUCKET);
  const { data, error } = await storage.list(companyId, { limit: 1000 });
  if (error) throw error;
  return data.map((entry) => entry.name);
}

/** A Company with a valid identity whose received invoices name it as customer. */
async function companyWithAi() {
  const user = await administratorWithCompany();
  const identity = { ico: "45274649", vatId: "CZ45274649" };
  const created = await createCompany(user.client, {
    organizationId: user.organizationId,
    ...companyDetails({ name: "Odběratel s.r.o.", ...identity }),
  });
  if (!created.ok) throw new Error(created.error);
  let extracted = 0;
  const worker = testWorker(fakeAiProvider({
    extract: () => ({
      ...SAMPLE_EXTRACTION,
      documentNumber: `FV-${++extracted}`,
      customer: { ...SAMPLE_EXTRACTION.customer, name: "Odběratel s.r.o.", ...identity },
    }),
  }));
  const admin = { ...user, companyId: created.value.id };
  await enableAiProcessing(admin.client, worker.jobs, { companyId: admin.companyId, provider: worker.ai });
  return { ...admin, worker };
}

describe("Upload Batch deletion", () => {
  it("lets the batch's creator delete it with every Source File, stored object and Document", async () => {
    const admin = await companyWithAi();
    const member = await companyMember(admin);
    const batchId = await finishedBatch(member.client, admin.worker, admin.companyId);
    const kept = await finishedBatch(admin.client, admin.worker, admin.companyId, [
      { fileName: "kept.png", fixture: "receipt.png" },
    ]);
    const [approved] = await batchDocumentIds(member.client, admin.companyId, batchId);
    expect(await approveDocument(member.client, {
      companyId: admin.companyId,
      documentId: approved,
      version: 1,
    })).toEqual({ ok: true, value: null });
    expect(await getUploadBatchDeletionPreview(member.client, (await getUploadBatch(member.client, admin.companyId, batchId))!)).toEqual({
      batchId,
      createdBy: member.userId,
      sourceFileCount: 2,
      documentCount: 3,
      approvedDocumentCount: 1,
      refusal: null,
    });

    expect(await deleteUploadBatch(member.client, { companyId: admin.companyId, batchId })).toEqual({
      ok: true,
      value: null,
    });

    expect(await getUploadBatch(member.client, admin.companyId, batchId)).toBeNull();
    expect((await listSourceFiles(member.client, admin.companyId)).map((file) => file.fileName)).toEqual(["kept.png"]);
    expect((await listCompanyDocuments(member.client, admin.companyId)).map((document) => document.id))
      .toEqual(await batchDocumentIds(admin.client, admin.companyId, kept));
    expect(await listUploadNotifications(member.client, admin.companyId)).toEqual([]);
    const keptSource = (await listSourceFiles(admin.client, admin.companyId))[0];
    expect(await storedObjectNames(admin.companyId)).toEqual([keptSource.id]);
    expect((await listAuditEvents(admin.client, admin.organizationId)).filter(
      (event) => event.action === "upload_batch.deleted",
    )).toEqual([
      expect.objectContaining({
        actorUserId: member.userId,
        companyId: admin.companyId,
        targetType: "upload_batch",
        targetId: batchId,
        payload: { sourceFileCount: 2, documentCount: 3, approvedDocumentCount: 1 },
      }),
    ]);
  });

  it("lets an Administrator delete another User's batch but refuses other Users and Organizations", async () => {
    const admin = await companyWithAi();
    const creator = await companyMember(admin);
    const otherUser = await companyMember(admin);
    const outsider = await administratorWithCompany("Other Organization");
    const batchId = await finishedBatch(creator.client, admin.worker, admin.companyId);
    const input = { companyId: admin.companyId, batchId };

    expect(await deleteUploadBatch(otherUser.client, input)).toEqual({ ok: false, error: "forbidden" });
    expect(await deleteUploadBatch(outsider.client, input)).toEqual({ ok: false, error: "forbidden" });
    expect((await otherUser.client.rpc("delete_upload_batch", { target_batch_id: batchId })).error?.code)
      .toBe("42501");
    expect((await otherUser.client.from("upload_batch").delete().eq("id", batchId)).error?.code).toBe("42501");
    expect((await otherUser.client.from("source_file").delete().eq("upload_batch_id", batchId)).error?.code)
      .toBe("42501");
    expect(await getUploadBatch(creator.client, admin.companyId, batchId)).toEqual(
      expect.objectContaining({ id: batchId, actualFileCount: 2 }),
    );

    expect(await deleteUploadBatch(admin.client, input)).toEqual({ ok: true, value: null });
    expect(await getUploadBatch(creator.client, admin.companyId, batchId)).toBeNull();
  });

  it("refuses to delete a batch that is still processing", async () => {
    const admin = await companyWithAi();
    const selection = selectFixtureFiles("receipt.png", "two-invoices.pdf");
    const batch = await beginUploadBatch(admin.client, { companyId: admin.companyId, fileCount: 2, selectedFiles: selection.selectedFiles });
    if (!batch.ok) throw new Error(batch.error);
    const uploaded = await uploadSourceFile(admin.client, admin.worker.jobs, {
      companyId: admin.companyId,
      batchId: batch.value.id,
      sourceFileId: selection.files[0].sourceFileId,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    const input = { companyId: admin.companyId, batchId: batch.value.id };

    expect(await deleteUploadBatch(admin.client, input)).toEqual({ ok: false, error: "batch_processing" });
    expect(await getUploadBatchDeletionPreview(admin.client, (await getUploadBatch(admin.client, admin.companyId, batch.value.id))!)).toEqual(
      expect.objectContaining({ sourceFileCount: 1, refusal: "batch_processing" }),
    );
    await finishUploadBatch(admin.client, batch.value.id);
    expect(await deleteUploadBatch(admin.client, input)).toEqual({ ok: false, error: "batch_processing" });
    expect(await getUploadBatch(admin.client, admin.companyId, batch.value.id)).toEqual(
      expect.objectContaining({ actualFileCount: 1 }),
    );
  });

  it("refuses to delete a batch with a Document in a locked Reporting Period and removes nothing", async () => {
    const admin = await companyWithAi();
    const batchId = await finishedBatch(admin.client, admin.worker, admin.companyId);
    const documentIds = await batchDocumentIds(admin.client, admin.companyId, batchId);
    for (const documentId of documentIds) {
      expect(await approveDocument(admin.client, { companyId: admin.companyId, documentId, version: 1 }))
        .toEqual({ ok: true, value: null });
    }
    const period = { companyId: admin.companyId, period: "2026-10" };
    expect((await generateVatReport(admin.client, period)).ok).toBe(true);
    expect(await finalizeVatReport(admin.client, { ...period, confirmed: true })).toEqual({ ok: true, value: null });
    const objectsBefore = await storedObjectNames(admin.companyId);

    expect(await deleteUploadBatch(admin.client, { companyId: admin.companyId, batchId })).toEqual({
      ok: false,
      error: "period_locked",
    });
    expect(await getUploadBatchDeletionPreview(admin.client, (await getUploadBatch(admin.client, admin.companyId, batchId))!)).toEqual(
      expect.objectContaining({ documentCount: 3, approvedDocumentCount: 3, refusal: "period_locked" }),
    );

    expect(await batchDocumentIds(admin.client, admin.companyId, batchId)).toEqual(documentIds);
    expect(await listSourceFiles(admin.client, admin.companyId)).toHaveLength(2);
    expect(await storedObjectNames(admin.companyId)).toEqual(objectsBefore);
    expect(objectsBefore).toHaveLength(2);
    expect(await listExtractionVersions(admin.client, admin.companyId, documentIds[0])).toHaveLength(1);
    expect(await listUploadNotifications(admin.client, admin.companyId)).toHaveLength(1);
  });

  it("keeps the AI Processing Allowance consumed by a deleted batch", async () => {
    const admin = await companyWithAi();
    const batchId = await finishedBatch(admin.client, admin.worker, admin.companyId);
    expect(await getCompanyAiProcessingAllowance(admin.client, admin.companyId)).toEqual({
      ok: true,
      value: { used: 3, allowance: 50, waitingDocuments: 0 },
    });

    expect(await deleteUploadBatch(admin.client, { companyId: admin.companyId, batchId })).toEqual({
      ok: true,
      value: null,
    });

    expect(await getCompanyAiProcessingAllowance(admin.client, admin.companyId)).toEqual({
      ok: true,
      value: { used: 3, allowance: 50, waitingDocuments: 0 },
    });
  });

  it("still deletes a batch when Storage fails, and removes its stored objects with the next deletion", async () => {
    const admin = await companyWithAi();
    const first = await finishedBatch(admin.client, admin.worker, admin.companyId, [
      { fileName: "first.png", fixture: "receipt.png" },
    ]);
    const second = await finishedBatch(admin.client, admin.worker, admin.companyId, [
      { fileName: "second.png", fixture: "receipt.png" },
    ]);
    const unavailableStorage = new Proxy(admin.client, {
      get(target, property, receiver) {
        if (property !== "storage") return Reflect.get(target, property, receiver);
        return {
          from: () => ({
            remove: async () => ({ data: null, error: new Error("Storage unavailable") }),
          }),
        };
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await deleteUploadBatch(unavailableStorage, { companyId: admin.companyId, batchId: first }))
      .toEqual({ ok: true, value: null });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    expect(await getUploadBatch(admin.client, admin.companyId, first)).toBeNull();
    expect(await storedObjectNames(admin.companyId)).toHaveLength(2);

    expect(await deleteUploadBatch(admin.client, { companyId: admin.companyId, batchId: second }))
      .toEqual({ ok: true, value: null });
    expect(await storedObjectNames(admin.companyId)).toEqual([]);
  });
});
