import { describe, expect, it } from "vitest";
import {
  beginUploadBatch,
  finishUploadBatch,
  getUploadBatch,
  listUploadBatches,
  listUploadNotifications,
  markUploadNotificationRead,
  uploadNotificationOutcome,
} from "@/application/upload-batches";
import { retrySplit, uploadSourceFile } from "@/application/source-files";
import { listCompanyDocuments, reprocessDocument } from "@/application/documents";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
  removeAiConfigurationFixture as disableAiProcessing,
  uploadBatchWithWaitingDocuments,
} from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";

describe("upload batches", () => {
  it("refuses a batch above the platform file-count limit", async () => {
    const { client, companyId } = await administratorWithCompany();

    const result = await beginUploadBatch(client, { companyId, fileCount: 101 });

    expect(result).toEqual({ ok: false, error: "too_many_files" });
  });

  it("notifies the uploading User when every Source File has finished processing", async () => {
    const { client, companyId } = await administratorWithCompany();
    const worker = testWorker();
    await enableAiProcessing(client, worker.jobs, { companyId, provider: worker.ai });
    const batch = await beginUploadBatch(client, { companyId, fileCount: 2 });
    if (!batch.ok) throw new Error(batch.error);

    for (const [fileName, fixture] of [
      ["invoices.pdf", "two-invoices.pdf"],
      ["receipt.png", "receipt.png"],
    ] as const) {
      const uploaded = await uploadSourceFile(client, worker.jobs, {
        companyId,
        batchId: batch.value.id,
        fileName,
        bytes: fixtureFile(fixture),
      });
      if (!uploaded.ok) throw new Error(uploaded.error);
    }
    expect(await finishUploadBatch(client, batch.value.id)).toEqual({
      ok: true,
      value: null,
    });
    expect(await listUploadNotifications(client, companyId)).toEqual([]);

    expect(await worker.runJobs()).toEqual([]);

    expect(await listUploadNotifications(client, companyId)).toEqual([
      {
        id: expect.any(String),
        batchId: batch.value.id,
        companyId,
        fileCount: 2,
        outcome: "success",
        reviewCount: 3,
        failureCount: 0,
        readAt: null,
        createdAt: expect.any(String),
      },
    ]);
    expect(await getUploadBatch(client, companyId, batch.value.id)).toEqual(
      expect.objectContaining({
        outcome: "success",
        actualFileCount: 2,
        counts: expect.objectContaining({ review: 3, failures: 0 }),
        sourceFiles: [
          expect.objectContaining({ fileName: "invoices.pdf", documents: expect.arrayContaining([
            expect.objectContaining({ firstPage: 1, lastPage: 1, status: "needs_review" }),
            expect.objectContaining({ firstPage: 2, lastPage: 2, status: "needs_review" }),
          ]) }),
          expect.objectContaining({ fileName: "receipt.png", documents: [
            expect.objectContaining({ firstPage: 1, lastPage: 1, status: "needs_review" }),
          ] }),
        ],
      }),
    );
  });

  it("persists a waiting-for-AI batch in Company history", async () => {
    const { client, companyId } = await administratorWithCompany();
    const worker = testWorker();
    const batch = await beginUploadBatch(client, { companyId, fileCount: 1 });
    if (!batch.ok) throw new Error(batch.error);
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      batchId: batch.value.id,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await finishUploadBatch(client, batch.value.id);

    expect(await getUploadBatch(client, companyId, batch.value.id)).toEqual(
      expect.objectContaining({
        outcome: "processing",
        counts: expect.objectContaining({ waiting: 1, splitting: 0, extracting: 0 }),
        sourceFiles: [expect.objectContaining({ fileName: "receipt.png", documents: [] })],
      }),
    );
    expect(await listUploadBatches(client, companyId)).toEqual([
      expect.objectContaining({ id: batch.value.id, outcome: "processing" }),
    ]);
    expect(await listUploadNotifications(client, companyId)).toEqual([]);
  });

  it("shows Documents waiting after Split separately from active Extraction", async () => {
    const { client, companyId } = await administratorWithCompany();
    const worker = testWorker();
    await enableAiProcessing(client, worker.jobs, { companyId, provider: worker.ai });
    const batch = await beginUploadBatch(client, { companyId, fileCount: 1 });
    if (!batch.ok) throw new Error(batch.error);
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      batchId: batch.value.id,
      fileName: "invoices.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await finishUploadBatch(client, batch.value.id);

    await worker.runNextJob();
    await disableAiProcessing(client, companyId);

    expect(await getUploadBatch(client, companyId, batch.value.id)).toEqual(
      expect.objectContaining({
        outcome: "processing",
        counts: expect.objectContaining({ waiting: 2, splitting: 0, extracting: 0 }),
      }),
    );
    expect(await listUploadBatches(client, companyId)).toEqual([
      expect.objectContaining({
        id: batch.value.id,
        counts: expect.objectContaining({ waiting: 2, extracting: 0 }),
      }),
    ]);
  });

  it("paginates durable history instead of hiding older batches", async () => {
    const { client, companyId } = await administratorWithCompany();
    for (let index = 0; index < 25; index++) {
      const batch = await beginUploadBatch(client, { companyId, fileCount: 1 });
      if (!batch.ok) throw new Error(batch.error);
    }

    const first = await listUploadBatches(client, companyId, { limit: 20 });
    const second = await listUploadBatches(client, companyId, { limit: 20, offset: 20 });

    expect(first).toHaveLength(20);
    expect(second).toHaveLength(5);
    expect(new Set([...first, ...second].map((batch) => batch.id)).size).toBe(25);
  });

  it("keeps above-limit batch totals and its filtered review queue complete", async () => {
    const { client, companyId, batchId } = await uploadBatchWithWaitingDocuments(1001);

    const workspace = await getUploadBatch(client, companyId, batchId);
    const history = await listUploadBatches(client, companyId);
    const queue = await listCompanyDocuments(client, companyId, {
      status: "uploaded",
      sourceFileIds: workspace?.sourceFiles.map((source) => source.id),
    });

    expect(workspace?.sourceFiles.flatMap((source) => source.documents)).toHaveLength(1001);
    expect(workspace?.counts).toEqual(expect.objectContaining({ waiting: 1001, extracting: 0 }));
    expect(history[0]?.counts).toEqual(expect.objectContaining({ waiting: 1001, extracting: 0 }));
    expect(queue).toHaveLength(1001);
  });

  it("never renders a legacy notification with missing outcome as success", () => {
    expect(uploadNotificationOutcome(undefined)).toBe("failure");
    expect(uploadNotificationOutcome("unknown")).toBe("failure");
    expect(uploadNotificationOutcome("success")).toBe("success");
  });

  it("shows partial Extraction success and refreshes the same notification after retry", async () => {
    const { client, companyId } = await administratorWithCompany();
    let extraction = 0;
    const worker = testWorker(fakeAiProvider({
      extract() {
        extraction += 1;
        if (extraction === 2) throw new Error("one extraction failed");
        return { ...SAMPLE_EXTRACTION, documentNumber: `DOC-${extraction}` };
      },
    }));
    await enableAiProcessing(client, worker.jobs, { companyId, provider: worker.ai });
    const batch = await beginUploadBatch(client, { companyId, fileCount: 1 });
    if (!batch.ok) throw new Error(batch.error);
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      batchId: batch.value.id,
      fileName: "invoices.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await finishUploadBatch(client, batch.value.id);
    expect(await worker.runJobs()).toEqual([expect.any(Error)]);

    const partial = await getUploadBatch(client, companyId, batch.value.id);
    expect(partial).toEqual(expect.objectContaining({
      outcome: "partial",
      counts: expect.objectContaining({ review: 1, documentFailures: 1, failures: 1 }),
    }));
    const firstNotification = (await listUploadNotifications(client, companyId))[0];
    expect(firstNotification).toEqual(expect.objectContaining({ outcome: "partial", reviewCount: 1, failureCount: 1 }));
    expect(await markUploadNotificationRead(client, firstNotification.id)).toEqual({ ok: true, value: null });
    expect(await listUploadNotifications(client, companyId, { unreadOnly: true })).toEqual([]);

    const failed = partial?.sourceFiles.flatMap((source) => source.documents).find((document) => document.status === "failed");
    if (!failed) throw new Error("expected a failed Document");
    expect(await reprocessDocument(client, worker.jobs, { companyId, documentId: failed.id })).toEqual({ ok: true, value: null });
    expect((await getUploadBatch(client, companyId, batch.value.id))?.outcome).toBe("processing");
    expect(await worker.runJobs()).toEqual([]);

    expect(await getUploadBatch(client, companyId, batch.value.id)).toEqual(expect.objectContaining({
      outcome: "success",
      counts: expect.objectContaining({ review: 2, failures: 0 }),
    }));
    expect(await listUploadNotifications(client, companyId)).toEqual([
      expect.objectContaining({ id: firstNotification.id, outcome: "success", reviewCount: 2, failureCount: 0, readAt: null }),
    ]);
  });

  it("isolates upload batches and notifications between Organizations", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await administratorWithCompany("Organization B");
    const worker = testWorker();
    await enableAiProcessing(a.client, worker.jobs, {
      companyId: a.companyId,
      provider: worker.ai,
    });
    const batch = await beginUploadBatch(a.client, {
      companyId: a.companyId,
      fileCount: 1,
    });
    if (!batch.ok) throw new Error(batch.error);
    const uploaded = await uploadSourceFile(a.client, worker.jobs, {
      companyId: a.companyId,
      batchId: batch.value.id,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await finishUploadBatch(a.client, batch.value.id);
    await worker.runJobs();

    expect(await finishUploadBatch(b.client, batch.value.id)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await listUploadNotifications(b.client, a.companyId)).toEqual([]);
    const notification = (await listUploadNotifications(a.client, a.companyId))[0];
    expect(await markUploadNotificationRead(b.client, notification.id)).toEqual({ ok: false, error: "forbidden" });
    expect(
      (await b.client.from("upload_batch").select("id").eq("id", batch.value.id))
        .data,
    ).toEqual([]);
    expect(
      (await b.client.from("notification").select("id").eq("company_id", a.companyId))
        .data,
    ).toEqual([]);
    expect(
      (await b.client.from("upload_batch").delete().eq("id", batch.value.id))
        .error?.code,
    ).toBe("42501");
    expect(
      (await b.client.from("notification").delete().eq("company_id", a.companyId))
        .error?.code,
    ).toBe("42501");
  });

  it("reopens a failed Split batch and replaces failure copy after retry", async () => {
    const { client, companyId } = await administratorWithCompany();
    let firstAttempt = true;
    const worker = testWorker(
      fakeAiProvider({
        split() {
          if (firstAttempt) {
            firstAttempt = false;
            throw new Error("provider unavailable");
          }
          return [{ firstPage: 1, lastPage: 1 }];
        },
      }),
    );
    await enableAiProcessing(client, worker.jobs, {
      companyId,
      provider: worker.ai,
    });
    const batch = await beginUploadBatch(client, { companyId, fileCount: 1 });
    if (!batch.ok) throw new Error(batch.error);
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      batchId: batch.value.id,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await finishUploadBatch(client, batch.value.id);

    expect(await worker.runJobs()).toEqual([expect.any(Error)]);
    expect(await listUploadNotifications(client, companyId)).toEqual([
      expect.objectContaining({
        batchId: batch.value.id,
        companyId,
        fileCount: 1,
        outcome: "failure",
        failureCount: 1,
      }),
    ]);
    const failed = await getUploadBatch(client, companyId, batch.value.id);
    expect(failed).toEqual(expect.objectContaining({ outcome: "failure", counts: expect.objectContaining({ sourceFailures: 1 }) }));
    const sourceFileId = failed?.sourceFiles[0]?.id;
    if (!sourceFileId) throw new Error("expected a Source File");
    expect(await retrySplit(client, worker.jobs, { companyId, sourceFileId })).toEqual({ ok: true, value: null });
    expect((await getUploadBatch(client, companyId, batch.value.id))?.outcome).toBe("processing");
    expect(await worker.runJobs()).toEqual([]);
    expect(await getUploadBatch(client, companyId, batch.value.id)).toEqual(expect.objectContaining({
      outcome: "success",
      counts: expect.objectContaining({ review: 1, failures: 0 }),
    }));
    expect(await listUploadNotifications(client, companyId)).toEqual([
      expect.objectContaining({ outcome: "success", reviewCount: 1, failureCount: 0 }),
    ]);
  });
});
