import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  beginUploadBatch,
  countUnreadUploadNotifications,
  dismissCompanyUploadNotifications,
  dismissUploadNotification,
  finishUploadBatch,
  getUploadBatch,
  listUploadBatches,
  listUploadNotifications,
  markCompanyUploadNotificationsRead,
  markUploadBatchNotificationRead,
  markUploadNotificationRead,
  uploadNotificationOutcome,
} from "@/application/upload-batches";
import { createCompany } from "@/application/companies";
import { listAuditEvents } from "@/application/audit";
import { retrySplit } from "@/application/source-files";
import { uploadSourceFile } from "./support/source-upload";
import { listCompanyDocuments, reprocessDocument } from "@/application/documents";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
  companyDetails,
  companyMember,
  legacyUploadBatchFixture,
  removeAiConfigurationFixture as disableAiProcessing,
  uploadBatchWithWaitingDocuments,
} from "./support/fixtures";
import { fixtureFile, selectFixtureFiles, selectUploadFiles } from "./support/files";
import { testWorker } from "./support/worker";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";

describe("upload batches", () => {
  it("restores the same started batch after response loss and refuses replacing its frozen file selection", async () => {
    const { client, companyId } = await administratorWithCompany();
    const worker = testWorker();
    const batchId = randomUUID();
    const sourceFileId = randomUUID();
    const selectedFiles = [{ id: sourceFileId, sha256: "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77" }];
    const input = { companyId, fileCount: 1, batchId, selectedFiles };
    expect(await Promise.all([beginUploadBatch(client, input), beginUploadBatch(client, input)]))
      .toEqual([{ ok: true, value: { id: batchId } }, { ok: true, value: { id: batchId } }]);
    expect(await beginUploadBatch(client, { ...input, selectedFiles: [{ ...selectedFiles[0], id: randomUUID() }] }))
      .toEqual({ ok: false, error: "invalid_choice" });
    expect(await uploadSourceFile(client, worker.jobs, {
      companyId, batchId, sourceFileId: randomUUID(), fileName: "replacement.png", bytes: fixtureFile("receipt.png"),
    })).toEqual({ ok: false, error: "invalid_choice" });
    const transfer = { companyId, batchId, sourceFileId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") };
    expect(await Promise.all([
      uploadSourceFile(client, worker.jobs, transfer),
      uploadSourceFile(client, worker.jobs, transfer),
    ])).toEqual([{ ok: true, value: { id: sourceFileId } }, { ok: true, value: { id: sourceFileId } }]);
    expect((await getUploadBatch(client, companyId, batchId))?.actualFileCount).toBe(1);
  });
  it("refuses concurrent renamed identical files in an existing legacy batch and keeps retries idempotent", async () => {
    const owner = await administratorWithCompany();
    const { client, companyId } = owner;
    const worker = testWorker();
    const batch = { value: { id: await legacyUploadBatchFixture(owner, 2) } };
    const first = { companyId, batchId: batch.value.id, sourceFileId: randomUUID(), fileName: "receipt.png", bytes: fixtureFile("receipt.png") };
    const results = await Promise.all([
      uploadSourceFile(client, worker.jobs, first),
      uploadSourceFile(client, worker.jobs, { ...first, sourceFileId: randomUUID(), fileName: "renamed.png" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: "identical_file" }]);
    expect((await getUploadBatch(client, companyId, batch.value.id))?.actualFileCount).toBe(1);
    const successfulInput = results[0].ok ? first : { ...first, sourceFileId: results[1].ok ? results[1].value.id : "", fileName: "renamed.png" };
    expect(await uploadSourceFile(client, worker.jobs, successfulInput)).toEqual(results.find((result) => result.ok));
    const different = new Uint8Array([...first.bytes, 1]);
    const differentUpload = await uploadSourceFile(client, worker.jobs, { ...first, sourceFileId: randomUUID(), bytes: different });
    expect(differentUpload.ok).toBe(true);
    expect((await getUploadBatch(client, companyId, batch.value.id))?.actualFileCount).toBe(2);
    const selection = selectFixtureFiles("receipt.png");
    const another = await beginUploadBatch(client, { companyId, fileCount: 1, selectedFiles: selection.selectedFiles });
    if (!another.ok) throw new Error(another.error);
    expect((await uploadSourceFile(client, worker.jobs, { ...first, batchId: another.value.id, sourceFileId: selection.files[0].sourceFileId })).ok).toBe(true);
  });
  it("refuses a batch above the platform file-count limit", async () => {
    const { client, companyId } = await administratorWithCompany();

    const selection = selectUploadFiles(Array.from({ length: 101 }, (_, index) => ({ fileName: `${index}.png`, bytes: new Uint8Array([...fixtureFile("receipt.png"), index]) })));
    const result = await beginUploadBatch(client, { companyId, fileCount: 101, selectedFiles: selection.selectedFiles });

    expect(result).toEqual({ ok: false, error: "too_many_files" });
  });

  it("notifies the uploading User when every Source File has finished processing", async () => {
    const { client, companyId } = await administratorWithCompany();
    const worker = testWorker();
    await enableAiProcessing(client, worker.jobs, { companyId, provider: worker.ai });
    const selection = selectFixtureFiles("two-invoices.pdf", "receipt.png");
    const batch = await beginUploadBatch(client, { companyId, fileCount: 2, selectedFiles: selection.selectedFiles });
    if (!batch.ok) throw new Error(batch.error);

    for (const [index, [fileName, fixture]] of ([
      ["invoices.pdf", "two-invoices.pdf"],
      ["receipt.png", "receipt.png"],
    ] as const).entries()) {
      const uploaded = await uploadSourceFile(client, worker.jobs, {
        companyId,
        batchId: batch.value.id,
        sourceFileId: selection.files[index].sourceFileId,
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
    const selection = selectFixtureFiles("receipt.png");
    const batch = await beginUploadBatch(client, { companyId, fileCount: 1, selectedFiles: selection.selectedFiles });
    if (!batch.ok) throw new Error(batch.error);
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      batchId: batch.value.id,
      sourceFileId: selection.files[0].sourceFileId,
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
    const selection = selectFixtureFiles("two-invoices.pdf");
    const batch = await beginUploadBatch(client, { companyId, fileCount: 1, selectedFiles: selection.selectedFiles });
    if (!batch.ok) throw new Error(batch.error);
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      batchId: batch.value.id,
      sourceFileId: selection.files[0].sourceFileId,
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
      const selection = selectFixtureFiles("receipt.png");
      const batch = await beginUploadBatch(client, { companyId, fileCount: 1, selectedFiles: selection.selectedFiles });
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
    const selection = selectFixtureFiles("two-invoices.pdf");
    const batch = await beginUploadBatch(client, { companyId, fileCount: 1, selectedFiles: selection.selectedFiles });
    if (!batch.ok) throw new Error(batch.error);
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      batchId: batch.value.id,
      sourceFileId: selection.files[0].sourceFileId,
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
    expect(await dismissUploadNotification(client, firstNotification.id)).toEqual({ ok: true, value: null });
    expect(await listUploadNotifications(client, companyId)).toEqual([]);

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
    const selection = selectFixtureFiles("receipt.png");
    const batch = await beginUploadBatch(a.client, {
      companyId: a.companyId,
      fileCount: 1,
      selectedFiles: selection.selectedFiles,
    });
    if (!batch.ok) throw new Error(batch.error);
    const uploaded = await uploadSourceFile(a.client, worker.jobs, {
      companyId: a.companyId,
      batchId: batch.value.id,
      sourceFileId: selection.files[0].sourceFileId,
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

  it("scopes bulk inbox actions to one Company and one User without changing audit history", async () => {
    const admin = await administratorWithCompany("Notification Organization");
    const member = await companyMember(admin);
    const second = await createCompany(admin.client, {
      organizationId: admin.organizationId,
      ...companyDetails({
        name: "Second Notification Company",
        ico: "87654321",
        vatId: "CZ87654321",
      }),
    });
    if (!second.ok) throw new Error(second.error);
    const worker = testWorker();
    await enableAiProcessing(admin.client, worker.jobs, {
      companyId: admin.companyId,
      provider: worker.ai,
    });
    await enableAiProcessing(admin.client, worker.jobs, {
      companyId: second.value.id,
      provider: worker.ai,
    });

    const completeBatch = async (client: typeof admin.client, companyId: string, fileName: string) => {
      const selection = selectFixtureFiles("receipt.png");
      const batch = await beginUploadBatch(client, { companyId, fileCount: 1, selectedFiles: selection.selectedFiles });
      if (!batch.ok) throw new Error(batch.error);
      const uploaded = await uploadSourceFile(client, worker.jobs, {
        companyId,
        batchId: batch.value.id,
        sourceFileId: selection.files[0].sourceFileId,
        fileName,
        bytes: fixtureFile("receipt.png"),
      });
      if (!uploaded.ok) throw new Error(uploaded.error);
      await finishUploadBatch(client, batch.value.id);
      await worker.runJobs();
    };

    await completeBatch(admin.client, admin.companyId, "admin-company-a.png");
    await completeBatch(admin.client, second.value.id, "admin-company-b.png");
    await completeBatch(member.client, admin.companyId, "member-company-a.png");

    const adminCompanyA = await listUploadNotifications(admin.client, admin.companyId);
    const adminCompanyB = await listUploadNotifications(admin.client, second.value.id);
    const memberCompanyA = await listUploadNotifications(member.client, admin.companyId);
    expect(adminCompanyA).toHaveLength(1);
    expect(adminCompanyB).toHaveLength(1);
    expect(memberCompanyA).toHaveLength(1);
    expect(await countUnreadUploadNotifications(admin.client, admin.companyId)).toBe(1);
    expect(await countUnreadUploadNotifications(admin.client, second.value.id)).toBe(1);

    expect(await markCompanyUploadNotificationsRead(admin.client, admin.companyId)).toEqual({
      ok: true,
      value: null,
    });
    expect((await listUploadNotifications(admin.client, admin.companyId))[0]?.readAt).not.toBeNull();
    expect(await countUnreadUploadNotifications(admin.client, admin.companyId)).toBe(0);
    expect((await listUploadNotifications(admin.client, second.value.id))[0]?.readAt).toBeNull();
    expect((await listUploadNotifications(member.client, admin.companyId))[0]?.readAt).toBeNull();

    expect(await dismissUploadNotification(admin.client, memberCompanyA[0].id)).toEqual({
      ok: false,
      error: "forbidden",
    });
    const auditBefore = await listAuditEvents(admin.client, admin.organizationId);
    expect(await dismissCompanyUploadNotifications(admin.client, admin.companyId)).toEqual({
      ok: true,
      value: null,
    });
    expect(await listUploadNotifications(admin.client, admin.companyId)).toEqual([]);
    expect(await listUploadNotifications(admin.client, second.value.id)).toHaveLength(1);
    expect(await listUploadNotifications(member.client, admin.companyId)).toHaveLength(1);
    expect(await listAuditEvents(admin.client, admin.organizationId)).toEqual(auditBefore);
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
    const selection = selectFixtureFiles("receipt.png");
    const batch = await beginUploadBatch(client, { companyId, fileCount: 1, selectedFiles: selection.selectedFiles });
    if (!batch.ok) throw new Error(batch.error);
    const uploaded = await uploadSourceFile(client, worker.jobs, {
      companyId,
      batchId: batch.value.id,
      sourceFileId: selection.files[0].sourceFileId,
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

  it("marks only the opener's notification read when a finished batch is opened, and reopens it after a retry", async () => {
    const admin = await administratorWithCompany();
    const member = await companyMember(admin);
    let extraction = 0;
    const worker = testWorker(fakeAiProvider({
      extract() {
        extraction += 1;
        if (extraction === 2) throw new Error("one extraction failed");
        return { ...SAMPLE_EXTRACTION, documentNumber: `DOC-${extraction}` };
      },
    }));
    await enableAiProcessing(admin.client, worker.jobs, { companyId: admin.companyId, provider: worker.ai });
    const selection = selectFixtureFiles("two-invoices.pdf");
    const batch = await beginUploadBatch(admin.client, { companyId: admin.companyId, fileCount: 1, selectedFiles: selection.selectedFiles });
    if (!batch.ok) throw new Error(batch.error);
    const uploaded = await uploadSourceFile(admin.client, worker.jobs, {
      companyId: admin.companyId,
      batchId: batch.value.id,
      sourceFileId: selection.files[0].sourceFileId,
      fileName: "invoices.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await finishUploadBatch(admin.client, batch.value.id);

    // Opened while still processing: nothing to read yet, completion stays announced.
    expect(await markUploadBatchNotificationRead(admin.client, batch.value.id)).toEqual({ ok: true, value: { changed: false } });
    expect(await worker.runJobs()).toEqual([expect.any(Error)]);
    expect(await countUnreadUploadNotifications(admin.client, admin.companyId)).toBe(1);

    expect(await markUploadBatchNotificationRead(member.client, batch.value.id)).toEqual({ ok: true, value: { changed: false } });
    expect(await countUnreadUploadNotifications(admin.client, admin.companyId)).toBe(1);

    expect(await markUploadBatchNotificationRead(admin.client, batch.value.id)).toEqual({ ok: true, value: { changed: true } });
    expect(await markUploadBatchNotificationRead(admin.client, batch.value.id)).toEqual({ ok: true, value: { changed: false } });
    expect(await listUploadNotifications(admin.client, admin.companyId)).toEqual([
      expect.objectContaining({ batchId: batch.value.id, readAt: expect.any(String) }),
    ]);
    expect(await countUnreadUploadNotifications(admin.client, admin.companyId)).toBe(0);

    const failed = (await getUploadBatch(admin.client, admin.companyId, batch.value.id))?.sourceFiles
      .flatMap((source) => source.documents)
      .find((document) => document.status === "failed");
    if (!failed) throw new Error("expected a failed Document");
    expect(await reprocessDocument(admin.client, worker.jobs, { companyId: admin.companyId, documentId: failed.id }))
      .toEqual({ ok: true, value: null });
    expect(await worker.runJobs()).toEqual([]);
    expect(await listUploadNotifications(admin.client, admin.companyId)).toEqual([
      expect.objectContaining({ batchId: batch.value.id, outcome: "success", readAt: null }),
    ]);
  });

  it("refuses to mark notifications read for a batch outside the User's Companies", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await administratorWithCompany("Organization B");
    const selection = selectFixtureFiles("receipt.png");
    const batch = await beginUploadBatch(a.client, { companyId: a.companyId, fileCount: 1, selectedFiles: selection.selectedFiles });
    if (!batch.ok) throw new Error(batch.error);

    expect(await markUploadBatchNotificationRead(b.client, batch.value.id)).toEqual({ ok: false, error: "forbidden" });
  });
});
