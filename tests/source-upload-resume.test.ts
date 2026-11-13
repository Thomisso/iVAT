import { sourceUploadAttempt } from "./support/source-upload";
import { expect, inject, it } from "vitest";
import { beginUploadBatch } from "@/application/upload-batches";
import { getSourceFile, readSourceFile } from "@/application/source-files";
import { reconcileSourceUpload, appendSourceUpload, completeSourceUpload } from "@/application/source-upload-transfers";
import { administratorWithCompany } from "./support/fixtures";
import { selectFixtureFiles } from "./support/files";
import { testWorker } from "./support/worker";
import { removeIsolatedUploadQueueFixture } from "./support/faults";

it("reconciles an interrupted immutable item and completes only its missing bytes", async () => {
  const owner = await administratorWithCompany();
  const worker = testWorker();
  const { files: [file], selectedFiles } = selectFixtureFiles("receipt.png");
  const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles });
  if (!batch.ok) throw new Error(batch.error);
  const identity = await sourceUploadAttempt(owner.client, { companyId: owner.companyId, batchId: batch.value.id, sourceFileId: file.sourceFileId,
    fileName: file.fileName, byteSize: file.bytes.length, sha256: selectedFiles[0].sha256 });
  expect(await reconcileSourceUpload(owner.client, identity)).toEqual({ ok: true, value: { attemptId: expect.any(String), confirmedBytes: 0, byteSize: file.bytes.length, complete: false } });
  expect(await appendSourceUpload(owner.client, { ...identity, offset: 0, bytes: file.bytes.slice(0, 20) })).toEqual({ ok: true, value: { attemptId: expect.any(String), confirmedBytes: 20, byteSize: file.bytes.length, complete: false } });
  expect(await getSourceFile(owner.client, owner.companyId, file.sourceFileId)).toBeNull();
  expect(worker.queued).toEqual([]);
  expect(await reconcileSourceUpload(owner.client, identity)).toEqual({ ok: true, value: { attemptId: expect.any(String), confirmedBytes: 20, byteSize: file.bytes.length, complete: false } });
  expect(await appendSourceUpload(owner.client, { ...identity, offset: 20, bytes: file.bytes.slice(20) })).toEqual({ ok: true, value: { attemptId: expect.any(String), confirmedBytes: file.bytes.length, byteSize: file.bytes.length, complete: false } });
  expect(await completeSourceUpload(owner.client, worker.jobs, identity)).toEqual({ ok: true, value: { id: file.sourceFileId } });
  const original = await readSourceFile(owner.client, owner.companyId, file.sourceFileId);
  expect(original?.bytes).toEqual(file.bytes);
  expect(original?.file.sha256).toBe("c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77");
});

it("refuses spliced bytes at a confirmed offset and incomplete completion without publishing evidence", async () => {
  const owner = await administratorWithCompany();
  const worker = testWorker();
  const { files: [file], selectedFiles } = selectFixtureFiles("receipt.png");
  const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles });
  if (!batch.ok) throw new Error(batch.error);
  const identity = await sourceUploadAttempt(owner.client, { companyId: owner.companyId, batchId: batch.value.id, sourceFileId: file.sourceFileId,
    fileName: file.fileName, byteSize: file.bytes.length, sha256: selectedFiles[0].sha256 });
  expect((await appendSourceUpload(owner.client, { ...identity, offset: 0, bytes: file.bytes.slice(0, 20) })).ok).toBe(true);
  expect(await appendSourceUpload(owner.client, { ...identity, offset: 0, bytes: new Uint8Array(20) })).toEqual({ ok: false, error: "invalid_choice" });
  expect(await appendSourceUpload(owner.client, { ...identity, offset: 21, bytes: file.bytes.slice(21) })).toEqual({ ok: false, error: "invalid_choice" });
  expect(await completeSourceUpload(owner.client, worker.jobs, identity)).toEqual({ ok: false, error: "upload_incomplete" });
  expect(await getSourceFile(owner.client, owner.companyId, file.sourceFileId)).toBeNull();
  expect(worker.queued).toEqual([]);
});

it("concurrent finalization and recovery after dispatch failure converge on one Source File and one AI result", async () => {
  const { fakeAiProvider, SAMPLE_EXTRACTION } = await import("@/ai/fake");
  const { assignAiConfigurationFixture } = await import("./support/fixtures");
  const { listCompanyDocuments, listExtractionVersions } = await import("@/application/documents");
  const { listSourceFiles } = await import("@/application/source-files");
  const owner = await administratorWithCompany();
  let splits = 0;
  let extractions = 0;
  const worker = testWorker(fakeAiProvider({ split: () => { splits++; return [{ firstPage: 1, lastPage: 1 }]; }, extract: () => { extractions++; return SAMPLE_EXTRACTION; } }));
  expect((await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai })).ok).toBe(true);
  const { files: [file], selectedFiles } = selectFixtureFiles("receipt.png");
  const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles });
  if (!batch.ok) throw new Error(batch.error);
  const identity = await sourceUploadAttempt(owner.client, { companyId: owner.companyId, batchId: batch.value.id, sourceFileId: file.sourceFileId,
    fileName: file.fileName, byteSize: file.bytes.length, sha256: selectedFiles[0].sha256 });
  expect((await appendSourceUpload(owner.client, { ...identity, offset: 0, bytes: file.bytes })).ok).toBe(true);
  await expect(completeSourceUpload(owner.client, { async send() { throw new Error("lost dispatch response"); } }, identity)).rejects.toThrow("lost dispatch response");
  const { PgBoss } = await import("pg-boss");
  const { createProcessingQueues, pgBossJobQueue } = await import("@/lib/jobs");
  const schema = `resume_${crypto.randomUUID().replaceAll("-", "")}`;
  const boss = new PgBoss({ connectionString: inject("databaseUrl"), schema, supervise: false, schedule: false });
  try {
    await boss.start();
    await createProcessingQueues(boss);
    const realQueue = pgBossJobQueue(boss);
    // The durable queue accepts the job, but its acknowledgement is lost.
    await expect(completeSourceUpload(owner.client, {
      async send(job, options) {
        await realQueue.send(job, options);
        throw new Error("lost enqueue acknowledgement");
      },
    }, identity)).rejects.toThrow("lost enqueue acknowledgement");
    expect(await Promise.all([completeSourceUpload(owner.client, realQueue, identity), completeSourceUpload(owner.client, realQueue, identity)]))
      .toEqual([{ ok: true, value: { id: file.sourceFileId } }, { ok: true, value: { id: file.sourceFileId } }]);
    const fetched = await boss.fetch<{ sourceFileId: string }>("split-source-file", { batchSize: 10 });
    expect(fetched).toHaveLength(1);
    worker.queued.push(...fetched.map(job => ({ name: "split-source-file" as const, data: job.data })));
    expect(await worker.runJobsConcurrently()).toEqual([]);
    await boss.complete("split-source-file", fetched[0].id);
    expect(await completeSourceUpload(owner.client, realQueue, identity)).toEqual({ ok: true, value: { id: file.sourceFileId } });
    expect(await boss.fetch("split-source-file", { batchSize: 10 })).toEqual([]);
  } finally {
    await boss.stop();
    await removeIsolatedUploadQueueFixture(schema);
  }
  expect(await listSourceFiles(owner.client, owner.companyId)).toHaveLength(1);
  const documents = await listCompanyDocuments(owner.client, owner.companyId);
  expect(documents).toHaveLength(1);
  expect(documents[0].status).toBe("needs_review");
  expect(await listExtractionVersions(owner.client, owner.companyId, documents[0].id)).toHaveLength(1);
  expect({ splits, extractions }).toEqual({ splits: 1, extractions: 1 });
});

it("checks final actual checksum and format before creating Source Files or AI work", async () => {
  const { selectUploadFiles } = await import("./support/files");
  const owner = await administratorWithCompany();
  const worker = testWorker();
  for (const invalidFormat of [false, true]) {
    const { files: [file], selectedFiles } = invalidFormat
      ? selectUploadFiles([{ fileName: "wrong.pdf", bytes: new Uint8Array([1, 2, 3, 4]) }])
      : selectFixtureFiles("receipt.png");
    const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles });
    if (!batch.ok) throw new Error(batch.error);
    const bytes = file.bytes.slice();
    if (!invalidFormat) bytes[bytes.length - 1] ^= 1;
    const identity = await sourceUploadAttempt(owner.client, { companyId: owner.companyId, batchId: batch.value.id, sourceFileId: file.sourceFileId,
      fileName: file.fileName, byteSize: bytes.length, sha256: selectedFiles[0].sha256 });
    expect((await appendSourceUpload(owner.client, { ...identity, offset: 0, bytes })).ok).toBe(true);
    expect(await completeSourceUpload(owner.client, worker.jobs, identity)).toEqual({ ok: false, error: invalidFormat ? "content_does_not_match_format" : "upload_checksum_mismatch" });
    expect(await getSourceFile(owner.client, owner.companyId, file.sourceFileId)).toBeNull();
  }
  expect(worker.queued).toEqual([]);
});

it("pins manifest identity and applies current byte, page and batch limits at completion while retaining completed evidence", async () => {
  const { getUploadLimits } = await import("@/application/source-files");
  const { finishUploadBatch } = await import("@/application/upload-batches");
  const { setPlatformUploadLimits } = await import("@/application/platform-administration");
  const { promotedSuperAdministrator } = await import("./support/platform");
  const { randomUUID } = await import("node:crypto");
  const owner = await administratorWithCompany();
  const platform = await promotedSuperAdministrator("Resume limits");
  const previous = await getUploadLimits(owner.client);
  const worker = testWorker();
  const { files, selectedFiles } = selectFixtureFiles("receipt.png", "two-invoices.pdf");
  const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles });
  if (!batch.ok) throw new Error(batch.error);
  const identities = await Promise.all(files.map(async (file, index) => sourceUploadAttempt(owner.client, { companyId: owner.companyId, batchId: batch.value.id, sourceFileId: file.sourceFileId,
    fileName: file.fileName, byteSize: file.bytes.length, sha256: selectedFiles[index].sha256 })));
  for (const [index, file] of files.entries()) expect((await appendSourceUpload(owner.client, { ...identities[index], offset: 0, bytes: file.bytes })).ok).toBe(true);
  const identity = identities[0];
  for (const mismatch of [{ sha256: "a".repeat(64) }, { sourceFileId: randomUUID() }, { fileName: "different.png" }, { byteSize: files[0].bytes.length + 1 }]) {
    expect(await reconcileSourceUpload(owner.client, { ...identity, ...mismatch })).toEqual({ ok: false, error: "invalid_choice" });
  }
  try {
    expect((await setPlatformUploadLimits(platform.client, { ...previous, maxFileBytes: 1 })).ok).toBe(true);
    expect(await completeSourceUpload(owner.client, worker.jobs, identity)).toEqual({ ok: false, error: "file_too_large" });
    expect((await setPlatformUploadLimits(platform.client, { ...previous, maxBatchFiles: 1 })).ok).toBe(true);
    expect(await completeSourceUpload(owner.client, worker.jobs, identity)).toEqual({ ok: false, error: "too_many_files" });
    expect((await setPlatformUploadLimits(platform.client, { ...previous, maxFilePages: 1 })).ok).toBe(true);
    expect(await completeSourceUpload(owner.client, worker.jobs, identities[1])).toEqual({ ok: false, error: "too_many_pages" });
    expect(await getSourceFile(owner.client, owner.companyId, identities[1].sourceFileId)).toBeNull();
    expect(await completeSourceUpload(owner.client, worker.jobs, identity)).toEqual({ ok: true, value: { id: identity.sourceFileId } });
    expect((await finishUploadBatch(owner.client, batch.value.id)).ok).toBe(true);
    expect((await setPlatformUploadLimits(platform.client, { ...previous, maxFileBytes: 1, maxBatchFiles: 1 })).ok).toBe(true);
    expect(await completeSourceUpload(owner.client, worker.jobs, identity)).toEqual({ ok: true, value: { id: identity.sourceFileId } });
    expect((await readSourceFile(owner.client, owner.companyId, identity.sourceFileId))?.bytes).toEqual(files[0].bytes);
  } finally {
    expect((await setPlatformUploadLimits(platform.client, previous)).ok).toBe(true);
  }
});

it("assembles every confirmed portion beyond the actual PostgREST response cap", async () => {
  const { sourceUploadChunkRowLimitProbe, withPostgrestRowLimit } = await import("./support/postgrest");
  const owner = await administratorWithCompany();
  const { files: [file], selectedFiles } = selectFixtureFiles("receipt.png");
  const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles });
  if (!batch.ok) throw new Error(batch.error);
  const identity = await sourceUploadAttempt(owner.client, { companyId: owner.companyId, batchId: batch.value.id, sourceFileId: file.sourceFileId,
    fileName: file.fileName, byteSize: file.bytes.length, sha256: selectedFiles[0].sha256 });
  for (const [offset, end] of [[0, 20], [20, 40], [40, file.bytes.length]]) {
    expect((await appendSourceUpload(owner.client, { ...identity, offset, bytes: file.bytes.slice(offset, end) })).ok).toBe(true);
  }
  await withPostgrestRowLimit(1,
    sourceUploadChunkRowLimitProbe(owner.client, file.sourceFileId),
    async () => {
      expect(await completeSourceUpload(owner.client, testWorker().jobs, identity)).toEqual({ ok: true, value: { id: file.sourceFileId } });
      expect((await readSourceFile(owner.client, owner.companyId, file.sourceFileId))?.bytes).toEqual(file.bytes);
    });
});
