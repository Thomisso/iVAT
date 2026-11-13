import { completeSourceUpload, sourceUploadValidator } from "./support/source-upload";
import { expect, inject, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { asUserClient } from "@/application/client";
import type { Database } from "@/lib/database.types";
import { beginUploadBatch } from "@/application/upload-batches";
import { appendSourceUpload, reconcileSourceUpload, restartSourceUpload } from "@/application/source-upload-transfers";
import { getSourceFile, readSourceFile } from "@/application/source-files";
import { uploadSourceFile } from "./support/source-upload";
import { runSourceUploadCleanupTick } from "@/application/source-upload-cleanup";
import { administratorWithCompany } from "./support/fixtures";
import { selectFixtureFiles } from "./support/files";
import { withUploadClock } from "./support/upload-clock";
import { supabaseHttpGateway } from "./support/supabase-http-gateway";
import { systemClient, testWorker } from "./support/worker";

function value<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function pendingUpload() {
  const owner = await administratorWithCompany();
  const { files: [file], selectedFiles } = selectFixtureFiles("receipt.png");
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles }));
  const identity = { companyId: owner.companyId, sourceFileId: file.sourceFileId, batchId: batch.id,
    fileName: file.fileName, byteSize: file.bytes.length, sha256: selectedFiles[0].sha256 };
  return { ...owner, file, identity };
}

it("expires at exactly seven days after new confirmation while duplicate portions do not renew", async () => {
  const item = await pendingUpload();
  await withUploadClock("2030-01-01T00:00:00.000000Z", async set => {
    const first = value(await reconcileSourceUpload(item.client, item.identity));
    value(await appendSourceUpload(item.client, { ...item.identity, expectedAttemptId: first.attemptId, offset: 0, bytes: item.file.bytes.slice(0, 20) }));
    await set("2030-01-07T23:59:59.999999Z");
    expect(value(await appendSourceUpload(item.client, { ...item.identity, expectedAttemptId: first.attemptId, offset: 0, bytes: item.file.bytes.slice(0, 20) })).confirmedBytes).toBe(20);
    await set("2030-01-08T00:00:00.000000Z");
    expect(await reconcileSourceUpload(item.client, item.identity)).toMatchObject({ ok: false, error: "upload_expired" });
    expect(await appendSourceUpload(item.client, { ...item.identity, expectedAttemptId: first.attemptId, offset: 20, bytes: item.file.bytes.slice(20) })).toMatchObject({ ok: false, error: "upload_expired" });
    await set("2030-01-08T00:00:00.000001Z");
    expect(await reconcileSourceUpload(item.client, item.identity)).toMatchObject({ ok: false, error: "upload_expired" });
  });
});

it("cleans actual expired temporary objects while preserving live attempts and completed originals", async () => {
  const expired = await pendingUpload();
  const live = await pendingUpload();
  const worker = testWorker();
  const system = systemClient();
  await withUploadClock("2030-01-01T00:00:00.000000Z", async set => {
    const first = value(await reconcileSourceUpload(expired.client, expired.identity));
    value(await appendSourceUpload(expired.client, { ...expired.identity, expectedAttemptId: first.attemptId, offset: 0, bytes: expired.file.bytes.slice(0, 20) }));
    const completed = value(await uploadSourceFile(live.client, worker.jobs, { companyId: live.companyId, fileName: "retained.png", bytes: live.file.bytes }));
    await set("2030-01-07T00:00:00.000000Z");
    const second = value(await reconcileSourceUpload(live.client, live.identity));
    value(await appendSourceUpload(live.client, { ...live.identity, expectedAttemptId: second.attemptId, offset: 0, bytes: live.file.bytes.slice(0, 20) }));
    const prefix = `${expired.companyId}/${expired.file.sourceFileId}/${first.attemptId}/0`;
    expect((await system.storage.from("source-upload-chunks").list(prefix)).data).toHaveLength(1);
    await set("2030-01-08T00:00:00.000000Z");
    await Promise.all([runSourceUploadCleanupTick(system), runSourceUploadCleanupTick(system)]);
    expect((await system.storage.from("source-upload-chunks").list(prefix)).data).toEqual([]);
    expect(value(await reconcileSourceUpload(live.client, live.identity)).confirmedBytes).toBe(20);
    expect((await readSourceFile(live.client, live.companyId, completed.id))?.bytes).toEqual(live.file.bytes);
  });
});

it("refuses an old completion paused before canonical Storage when a restart wins", async () => {
  const item = await pendingUpload();
  const worker = testWorker();
  const gateway = await supabaseHttpGateway(inject("supabaseUrl"));
  const transport = asUserClient(createClient<Database>(gateway.url, inject("supabaseAnonKey"), { auth: { persistSession: false, autoRefreshToken: false } }));
  value(await transport.auth.setSession((await item.client.auth.getSession()).data.session!).then(result => result.error ? { ok: false, error: result.error.message } : { ok: true, value: undefined }));
  try {
    await withUploadClock("2030-01-01T00:00:00.000000Z", async set => {
      const first = value(await reconcileSourceUpload(item.client, item.identity));
      const old = { ...item.identity, expectedAttemptId: first.attemptId };
      value(await appendSourceUpload(item.client, { ...old, offset: 0, bytes: item.file.bytes }));
      const held = gateway.holdNext("/storage/v1/object/source-files/");
      const completing = completeSourceUpload(transport, worker.jobs, old, sourceUploadValidator(gateway.url));
      await held.started;
      try {
        await set("2030-01-08T00:00:00.000000Z");
        value(await restartSourceUpload(item.client, old));
      } finally { held.release(); }
      expect(await completing).toMatchObject({ ok: false, error: "upload_attempt_changed" });
      expect(await getSourceFile(item.client, item.companyId, item.file.sourceFileId)).toBeNull();
      expect(worker.queued).toEqual([]);
    });
  } finally { gateway.close(); }
});

it("explicitly restarts the same expired item once and refuses the old attempt", async () => {
  const item = await pendingUpload();
  await withUploadClock("2030-01-01T00:00:00.000000Z", async set => {
    const first = value(await reconcileSourceUpload(item.client, item.identity));
    value(await appendSourceUpload(item.client, { ...item.identity, expectedAttemptId: first.attemptId, offset: 0, bytes: item.file.bytes.slice(0, 20) }));
    await set("2030-01-08T00:00:00.000000Z");
    const restarted = value(await restartSourceUpload(item.client, { ...item.identity, expectedAttemptId: first.attemptId }));
    expect(restarted.confirmedBytes).toBe(0);
    expect(restarted.attemptId).not.toBe(first.attemptId);
    value(await appendSourceUpload(item.client, { ...item.identity, expectedAttemptId: restarted.attemptId, offset: 0, bytes: item.file.bytes.slice(0, 20) }));
    expect(value(await restartSourceUpload(item.client, { ...item.identity, expectedAttemptId: first.attemptId }))).toEqual({ ...restarted, confirmedBytes: 20 });
    expect(await appendSourceUpload(item.client, { ...item.identity, expectedAttemptId: first.attemptId, offset: 20, bytes: item.file.bytes.slice(20) })).toMatchObject({ ok: false, error: "upload_attempt_changed" });
    expect(value(await reconcileSourceUpload(item.client, item.identity)).confirmedBytes).toBe(20);
    value(await appendSourceUpload(item.client, { ...item.identity, expectedAttemptId: restarted.attemptId, offset: 20, bytes: item.file.bytes.slice(20) }));
    value(await completeSourceUpload(item.client, testWorker().jobs, { ...item.identity, expectedAttemptId: restarted.attemptId }));
    expect(value(await restartSourceUpload(item.client, { ...item.identity, expectedAttemptId: first.attemptId }))).toEqual({ ...restarted, confirmedBytes: item.file.bytes.length, complete: true });
  });
});

it("retains a retired tombstone after an empty sweep and later removes an admitted late Storage commit", async () => {
  const item = await pendingUpload();
  const system = systemClient();
  const { createHash } = await import("node:crypto");
  const { cancelSourceUpload } = await import("@/application/source-upload-transfers");
  const { delayedTemporaryWrite } = await import("./support/upload-lifecycle");
  await withUploadClock("2030-01-01T00:00:00.000000Z", async () => {
    const first = value(await reconcileSourceUpload(item.client, item.identity));
    const old = { ...item.identity, expectedAttemptId: first.attemptId };
    value(await appendSourceUpload(item.client, { ...old, offset: 0, bytes: item.file.bytes.slice(0, 20) }));
    const remaining = item.file.bytes.slice(20);
    const sha = createHash("sha256").update(remaining).digest("hex");
    const path = `${item.companyId}/${item.file.sourceFileId}/${first.attemptId}/20/${sha}`;
    await delayedTemporaryWrite(path,
      // Provider-side arrival is controlled at the real Storage boundary. The
      // service identity lets this committed write outlive current user RLS.
      () => system.storage.from("source-upload-chunks").upload(path, remaining, { contentType: "application/octet-stream" }),
      async finish => {
        value(await cancelSourceUpload(item.client, old));
        const replacement = value(await restartSourceUpload(item.client, old));
        value(await appendSourceUpload(item.client, { ...item.identity, expectedAttemptId: replacement.attemptId, offset: 0, bytes: item.file.bytes.slice(0, 20) }));
        await runSourceUploadCleanupTick(system);
        expect((await system.storage.from("source-upload-chunks").list(`${item.companyId}/${item.file.sourceFileId}/${first.attemptId}/20`)).data).toEqual([]);
        expect((await finish()).error).toBeNull();
        expect((await system.storage.from("source-upload-chunks").list(`${item.companyId}/${item.file.sourceFileId}/${first.attemptId}/20`)).data).toHaveLength(1);
        expect((await item.client.rpc("confirm_source_upload_chunk", { target_source_file_id: item.file.sourceFileId, expected_attempt_id: first.attemptId!, chunk_offset: 20, chunk_byte_size: remaining.length, chunk_sha256: sha })).error?.hint).toBe("upload_attempt_changed");
        await runSourceUploadCleanupTick(system);
        expect((await system.storage.from("source-upload-chunks").list(`${item.companyId}/${item.file.sourceFileId}/${first.attemptId}/20`)).data).toEqual([]);
        expect(value(await reconcileSourceUpload(item.client, item.identity)).confirmedBytes).toBe(20);
        const liveObjects = await system.storage.from("source-upload-chunks").list(`${item.companyId}/${item.file.sourceFileId}/${replacement.attemptId}/0`);
        expect(liveObjects.data).toHaveLength(1);
        const bytes = await system.storage.from("source-upload-chunks").download(`${item.companyId}/${item.file.sourceFileId}/${replacement.attemptId}/0/${liveObjects.data![0].name}`);
        expect(new Uint8Array(await bytes.data!.arrayBuffer())).toEqual(item.file.bytes.slice(0, 20));
      });
  });
});

it("cleans only four-segment legacy objects and preserves five-segment replacement progress", async () => {
  const item = await pendingUpload();
  const system = systemClient();
  const { legacyUploadLayoutFixture } = await import("./support/upload-lifecycle");
  await withUploadClock("2030-01-01T00:00:00.000000Z", async set => {
    const first = value(await reconcileSourceUpload(item.client, item.identity));
    await legacyUploadLayoutFixture(item.file.sourceFileId);
    value(await appendSourceUpload(item.client, { ...item.identity, expectedAttemptId: first.attemptId, offset: 0, bytes: item.file.bytes.slice(0, 20) }));
    expect(value(await reconcileSourceUpload(item.client, item.identity)).confirmedBytes).toBe(20);
    expect((await system.storage.from("source-upload-chunks").list(`${item.companyId}/${item.file.sourceFileId}/0`)).data).toHaveLength(1);
    await set("2030-01-08T00:00:00.000000Z");
    const replacement = value(await restartSourceUpload(item.client, { ...item.identity, expectedAttemptId: first.attemptId }));
    value(await appendSourceUpload(item.client, { ...item.identity, expectedAttemptId: replacement.attemptId, offset: 0, bytes: item.file.bytes.slice(0, 20) }));
    await runSourceUploadCleanupTick(system);
    expect((await system.storage.from("source-upload-chunks").list(`${item.companyId}/${item.file.sourceFileId}/0`)).data).toEqual([]);
    expect((await system.storage.from("source-upload-chunks").list(`${item.companyId}/${item.file.sourceFileId}/${replacement.attemptId}/0`)).data).toHaveLength(1);
    expect(value(await reconcileSourceUpload(item.client, item.identity)).confirmedBytes).toBe(20);
  });
});

it("renews only for a newly confirmed portion and gives empty attempts the same seven-day window", async () => {
  const item = await pendingUpload();
  const empty = await pendingUpload();
  await withUploadClock("2030-01-01T00:00:00.000000Z", async set => {
    const first = value(await reconcileSourceUpload(item.client, item.identity));
    value(await reconcileSourceUpload(empty.client, empty.identity));
    await set("2030-01-07T00:00:00.000000Z");
    value(await appendSourceUpload(item.client, { ...item.identity, expectedAttemptId: first.attemptId, offset: 0, bytes: item.file.bytes.slice(0, 20) }));
    await set("2030-01-08T00:00:00.000000Z");
    expect(await reconcileSourceUpload(empty.client, empty.identity)).toMatchObject({ ok: false, error: "upload_expired" });
    expect(value(await reconcileSourceUpload(item.client, item.identity)).confirmedBytes).toBe(20);
    expect((await item.client.rpc("confirm_source_upload_chunk", { target_source_file_id: item.file.sourceFileId, expected_attempt_id: first.attemptId!, chunk_offset: 20, chunk_byte_size: 1, chunk_sha256: "a".repeat(64) })).error?.hint).toBe("invalid_choice");
    await set("2030-01-14T00:00:00.000000Z");
    expect(await reconcileSourceUpload(item.client, item.identity)).toMatchObject({ ok: false, error: "upload_expired" });
  });
});

it("keeps cancellation idempotent and cleanup durable after authorized finished-batch deletion", async () => {
  const item = await pendingUpload();
  const { cancelSourceUpload } = await import("@/application/source-upload-transfers");
  const { finishUploadBatch, deleteUploadBatch, getUploadBatch } = await import("@/application/upload-batches");
  const system = systemClient();
  const first = value(await reconcileSourceUpload(item.client, item.identity));
  const attempt = { ...item.identity, expectedAttemptId: first.attemptId };
  value(await appendSourceUpload(item.client, { ...attempt, offset: 0, bytes: item.file.bytes.slice(0, 20) }));
  expect(value(await cancelSourceUpload(item.client, attempt)).complete).toBe(false);
  expect(value(await cancelSourceUpload(item.client, attempt)).attemptId).toBe(first.attemptId);
  expect(await reconcileSourceUpload(item.client, item.identity)).toMatchObject({ ok: false, error: "upload_cancelled" });
  value(await finishUploadBatch(item.client, item.identity.batchId));
  expect(await restartSourceUpload(item.client, attempt)).toMatchObject({ ok: false, error: "forbidden" });
  value(await deleteUploadBatch(item.client, { companyId: item.companyId, batchId: item.identity.batchId }));
  expect(await getUploadBatch(item.client, item.companyId, item.identity.batchId)).toBeNull();
  await runSourceUploadCleanupTick(system);
  expect((await system.storage.from("source-upload-chunks").list(`${item.companyId}/${item.file.sourceFileId}/${first.attemptId}/0`)).data).toEqual([]);
});

it("refuses changed manifest identity, foreign authority and direct expired publication or transport", async () => {
  const item = await pendingUpload();
  const foreign = await administratorWithCompany();
  const { createHash, randomUUID } = await import("node:crypto");
  const worker = testWorker();
  await withUploadClock("2030-01-01T00:00:00.000000Z", async set => {
    const first = value(await reconcileSourceUpload(item.client, item.identity));
    const attempt = { ...item.identity, expectedAttemptId: first.attemptId };
    value(await appendSourceUpload(item.client, { ...attempt, offset: 0, bytes: item.file.bytes.slice(0, 20) }));
    await set("2030-01-08T00:00:00.000000Z");
    for (const mismatch of [{ sourceFileId: randomUUID() }, { sha256: "a".repeat(64) }, { byteSize: item.file.bytes.length + 1 }, { fileName: "different.png" }]) {
      expect(await restartSourceUpload(item.client, { ...attempt, ...mismatch })).toMatchObject({ ok: false, error: "invalid_choice" });
    }
    expect(await restartSourceUpload(foreign.client, attempt)).toMatchObject({ ok: false, error: "forbidden" });
    for (const table of ["source_upload_transfer", "source_upload_chunk"] as const) {
      expect((await foreign.client.from(table).select("source_file_id").eq("source_file_id", item.file.sourceFileId)).data).toEqual([]);
      expect((await foreign.client.from(table).delete().eq("source_file_id", item.file.sourceFileId)).error?.code).toBe("42501");
    }
    const path = `${item.companyId}/${item.file.sourceFileId}/${first.attemptId}/0/${createHash("sha256").update(item.file.bytes.slice(0, 20)).digest("hex")}`;
    expect((await item.client.storage.from("source-upload-chunks").download(path)).error).not.toBeNull();
    expect((await item.client.storage.from("source-upload-chunks").upload(path, item.file.bytes.slice(0, 20), { upsert: false, contentType: "application/octet-stream" })).error).not.toBeNull();
    expect((await item.client.rpc("confirm_source_upload_chunk", { target_source_file_id: item.file.sourceFileId, expected_attempt_id: first.attemptId!, chunk_offset: 20, chunk_byte_size: 1, chunk_sha256: "a".repeat(64) })).error?.hint).toBe("upload_expired");
    expect(await uploadSourceFile(item.client, worker.jobs, { companyId: item.companyId, batchId: item.identity.batchId, sourceFileId: item.file.sourceFileId, fileName: item.file.fileName, bytes: item.file.bytes })).toEqual({ ok: false, error: "forbidden" });
    expect(await getSourceFile(item.client, item.companyId, item.file.sourceFileId)).toBeNull();
    expect(worker.queued).toEqual([]);
  });
});

it("retries failed cleanup and concurrent ticks without deleting a live replacement", async () => {
  const item = await pendingUpload();
  const system = systemClient();
  const gateway = await supabaseHttpGateway(inject("supabaseUrl"));
  const { cancelSourceUpload } = await import("@/application/source-upload-transfers");
  try {
    const first = value(await reconcileSourceUpload(item.client, item.identity));
    const attempt = { ...item.identity, expectedAttemptId: first.attemptId };
    value(await appendSourceUpload(item.client, { ...attempt, offset: 0, bytes: item.file.bytes }));
    const claim = await item.client.rpc("begin_source_upload_validation", {target_company_id:item.companyId,target_batch_id:item.identity.batchId,target_source_file_id:item.file.sourceFileId,
      original_file_name:item.file.fileName,original_byte_size:item.file.bytes.length,original_sha256:item.identity.sha256,expected_attempt_id:first.attemptId!});
    if(claim.error)throw claim.error;
    value(await sourceUploadValidator().validateAndStage(claim.data));
    value(await cancelSourceUpload(item.client, attempt));
    const replacement = value(await restartSourceUpload(item.client, attempt));
    value(await appendSourceUpload(item.client, { ...item.identity, expectedAttemptId: replacement.attemptId, offset: 0, bytes: item.file.bytes.slice(0, 20) }));
    gateway.unavailable(true, "/storage/v1/object/source-upload-chunks");
    await expect(runSourceUploadCleanupTick(systemClient(gateway.url))).rejects.toBeDefined();
    const prefix = `${item.companyId}/${item.file.sourceFileId}/${first.attemptId}/0`;
    expect((await system.storage.from("source-upload-chunks").list(prefix)).data).toHaveLength(1);
    expect((await system.storage.from("source-files").list(`${item.companyId}/${item.file.sourceFileId}/transfer/${first.attemptId}`)).data).toEqual([]);
    gateway.unavailable(false);
    await Promise.all([runSourceUploadCleanupTick(systemClient(gateway.url)), runSourceUploadCleanupTick(system)]);
    expect((await system.storage.from("source-upload-chunks").list(prefix)).data).toEqual([]);
    expect(value(await reconcileSourceUpload(item.client, item.identity)).confirmedBytes).toBe(20);
  } finally { gateway.close(); }
});

it("cleans partial bytes after export-authorized Company deletion while retaining original evidence", async () => {
  const item = await pendingUpload();
  const worker = testWorker();
  const { exportCompanyData, getCompanyDataExportStatus, softDeleteCompany } = await import("@/application/company-deletion");
  const first = value(await reconcileSourceUpload(item.client, item.identity));
  value(await appendSourceUpload(item.client, { ...item.identity, expectedAttemptId: first.attemptId, offset: 0, bytes: item.file.bytes.slice(0, 20) }));
  const original = value(await uploadSourceFile(item.client, worker.jobs, { companyId: item.companyId, fileName: "retained.png", bytes: item.file.bytes }));
  expect(await worker.runJobs()).toEqual([]);
  const exported = value(await exportCompanyData(item.client, worker.jobs, { companyId: item.companyId }));
  expect(await worker.runJobs()).toEqual([]);
  expect(value(await getCompanyDataExportStatus(item.client, { companyId: item.companyId, exportId: exported.exportId }))).toBe("completed");
  expect(value(await softDeleteCompany(item.client, { companyId: item.companyId, exportId: exported.exportId })).sourceFileCount).toBe(1);
  expect(await reconcileSourceUpload(item.client, item.identity)).toMatchObject({ ok: false, error: "forbidden" });
  await runSourceUploadCleanupTick(systemClient());
  expect((await systemClient().storage.from("source-upload-chunks").list(`${item.companyId}/${item.file.sourceFileId}/${first.attemptId}/0`)).data).toEqual([]);
  const retained = await systemClient().storage.from("source-files").download(`${item.companyId}/${original.id}`);
  expect(new Uint8Array(await retained.data!.arrayBuffer())).toEqual(item.file.bytes);
});

it("retains completed attempt reconciliation and durable processing after chunk cleanup, finish and seven days", async () => {
  const item = await pendingUpload();
  const worker = testWorker();
  const { assignAiConfigurationFixture } = await import("./support/fixtures");
  const { finishUploadBatch } = await import("@/application/upload-batches");
  const { listCompanyDocuments, listExtractionVersions } = await import("@/application/documents");
  value(await assignAiConfigurationFixture(item.client, worker.jobs, { companyId: item.companyId, provider: worker.ai }));
  await withUploadClock("2030-01-01T00:00:00.000000Z", async set => {
    const first = value(await reconcileSourceUpload(item.client, item.identity));
    const attempt = { ...item.identity, expectedAttemptId: first.attemptId };
    value(await appendSourceUpload(item.client, { ...attempt, offset: 0, bytes: item.file.bytes }));
    value(await completeSourceUpload(item.client, worker.jobs, attempt));
    expect(await worker.runJobsConcurrently()).toEqual([]);
    value(await finishUploadBatch(item.client, item.identity.batchId));
    await set("2030-01-09T00:00:00.000000Z");
    await runSourceUploadCleanupTick(systemClient());
    expect(value(await reconcileSourceUpload(item.client, item.identity))).toEqual({ ...first, confirmedBytes: item.file.bytes.length, complete: true });
    expect(await completeSourceUpload(item.client, worker.jobs, attempt)).toEqual({ ok: true, value: { id: item.file.sourceFileId } });
    expect(await worker.runJobsConcurrently()).toEqual([]);
    expect((await readSourceFile(item.client, item.companyId, item.file.sourceFileId))?.bytes).toEqual(item.file.bytes);
    const documents = await listCompanyDocuments(item.client, item.companyId);
    expect(documents).toHaveLength(1);
    expect(documents[0].status).toBe("needs_review");
    expect(await listExtractionVersions(item.client, item.companyId, documents[0].id)).toHaveLength(1);
  });
});

it("reconciles completed full-file uploads without creating a transport attempt", async () => {
  const item = await pendingUpload();
  const worker = testWorker();
  const { finishUploadBatch } = await import("@/application/upload-batches");
  value(await uploadSourceFile(item.client, worker.jobs, { companyId: item.companyId, batchId: item.identity.batchId, sourceFileId: item.file.sourceFileId, fileName: item.file.fileName, bytes: item.file.bytes }));
  value(await finishUploadBatch(item.client, item.identity.batchId));
  expect(value(await reconcileSourceUpload(item.client, item.identity))).toEqual({ attemptId: null, confirmedBytes: item.file.bytes.length, byteSize: item.file.bytes.length, complete: true });
  expect(await completeSourceUpload(item.client, worker.jobs, { ...item.identity, expectedAttemptId: null })).toEqual({ ok: true, value: { id: item.file.sourceFileId } });
});

it("refuses final publication when expiry cleanup wins after assembly and original storage", async () => {
  const item = await pendingUpload();
  const worker = testWorker();
  const gateway = await supabaseHttpGateway(inject("supabaseUrl"));
  const transport = asUserClient(createClient<Database>(gateway.url, inject("supabaseAnonKey"), { auth: { persistSession: false, autoRefreshToken: false } }));
  const session = (await item.client.auth.getSession()).data.session!;
  if ((await transport.auth.setSession(session)).error) throw new Error("Native session transport failed");
  try {
    await withUploadClock("2030-01-01T00:00:00.000000Z", async set => {
      const first = value(await reconcileSourceUpload(item.client, item.identity));
      const attempt = { ...item.identity, expectedAttemptId: first.attemptId };
      value(await appendSourceUpload(item.client, { ...attempt, offset: 0, bytes: item.file.bytes }));
      const held = gateway.holdNext("/rest/v1/rpc/publish_source_upload");
      const completing = completeSourceUpload(transport, worker.jobs, attempt, sourceUploadValidator(gateway.url));
      await held.started;
      try {
        await set("2030-01-08T00:00:00.000000Z");
        await runSourceUploadCleanupTick(systemClient());
      } finally { held.release(); }
      expect(await completing).toMatchObject({ ok: false, error: "upload_expired" });
      expect(await getSourceFile(item.client, item.companyId, item.file.sourceFileId)).toBeNull();
      expect(worker.queued).toEqual([]);
      expect(value(await restartSourceUpload(item.client, attempt)).confirmedBytes).toBe(0);
    });
  } finally { gateway.close(); }
});

it("preserves the completed original when publication wins the Company lock before cancellation", async () => {
  const item = await pendingUpload();
  const worker = testWorker();
  const gateway = await supabaseHttpGateway(inject("supabaseUrl"));
  const { cancelSourceUpload } = await import("@/application/source-upload-transfers");
  const { orderedUploadCommands } = await import("./support/upload-lifecycle");
  const transport = asUserClient(createClient<Database>(gateway.url, inject("supabaseAnonKey"), { auth: { persistSession: false, autoRefreshToken: false } }));
  if ((await transport.auth.setSession((await item.client.auth.getSession()).data.session!)).error) throw new Error("Native session transport failed");
  try {
    const first = value(await reconcileSourceUpload(item.client, item.identity));
    const attempt = { ...item.identity, expectedAttemptId: first.attemptId };
    value(await appendSourceUpload(item.client, { ...attempt, offset: 0, bytes: item.file.bytes }));
    const held = gateway.holdNext("/rest/v1/rpc/publish_source_upload");
    const completing = completeSourceUpload(transport, worker.jobs, attempt, sourceUploadValidator(gateway.url));
    await held.started;
    let results;
    try {
      results = await orderedUploadCommands(item.companyId, [
        { query: "publish_source_upload", run: () => { held.release(); return completing; } },
        { query: "cancel_source_upload", run: () => cancelSourceUpload(item.client, attempt) },
      ]);
    } finally { held.release(); }
    expect(results).toEqual([
      { status: "fulfilled", value: { ok: true, value: { id: item.file.sourceFileId } } },
      { status: "fulfilled", value: { ok: true, value: { ...first, confirmedBytes: item.file.bytes.length, complete: true } } },
    ]);
    await runSourceUploadCleanupTick(systemClient());
    expect((await readSourceFile(item.client, item.companyId, item.file.sourceFileId))?.bytes).toEqual(item.file.bytes);
    expect(value(await reconcileSourceUpload(item.client, item.identity)).complete).toBe(true);
  } finally { gateway.close(); }
});

it("uses seven elapsed days across a caller-selected daylight-saving timezone", async () => {
  const item = await pendingUpload();
  const transport = asUserClient(createClient<Database>(inject("supabaseUrl"), inject("supabaseAnonKey"), {
    auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Prefer: "timezone=Europe/Prague" } },
  }));
  if ((await transport.auth.setSession((await item.client.auth.getSession()).data.session!)).error) throw new Error("Native session transport failed");
  await withUploadClock("2030-03-25T00:00:00.000000Z", async set => {
    value(await reconcileSourceUpload(item.client, item.identity));
    await set("2030-03-31T23:30:00.000000Z");
    expect(value(await reconcileSourceUpload(transport, item.identity)).confirmedBytes).toBe(0);
    await set("2030-04-01T00:00:00.000000Z");
    expect(await reconcileSourceUpload(transport, item.identity)).toMatchObject({ ok: false, error: "upload_expired" });
  });
});

it("reports expiry when a previously admitted append loses its Storage admission at the deadline", async () => {
  const item = await pendingUpload();
  const gateway = await supabaseHttpGateway(inject("supabaseUrl"));
  const transport = asUserClient(createClient<Database>(gateway.url, inject("supabaseAnonKey"), { auth: { persistSession: false, autoRefreshToken: false } }));
  if ((await transport.auth.setSession((await item.client.auth.getSession()).data.session!)).error) throw new Error("Native session transport failed");
  try {
    await withUploadClock("2030-01-01T00:00:00.000000Z", async set => {
      const first = value(await reconcileSourceUpload(item.client, item.identity));
      const held = gateway.holdNext("/storage/v1/object/source-upload-chunks/");
      const appending = appendSourceUpload(transport, { ...item.identity, expectedAttemptId: first.attemptId, offset: 0, bytes: item.file.bytes.slice(0, 20) });
      await held.started;
      try { await set("2030-01-08T00:00:00.000000Z"); }
      finally { held.release(); }
      expect(await appending).toMatchObject({ ok: false, error: "upload_expired" });
      expect(await getSourceFile(item.client, item.companyId, item.file.sourceFileId)).toBeNull();
    });
  } finally { gateway.close(); }
});

it("converges when another completion publishes and cleans chunks before a retry reads their metadata", async () => {
  const item = await pendingUpload();
  const worker = testWorker();
  const gateway = await supabaseHttpGateway(inject("supabaseUrl"));
  const transport = asUserClient(createClient<Database>(gateway.url, inject("supabaseAnonKey"), { auth: { persistSession: false, autoRefreshToken: false } }));
  if ((await transport.auth.setSession((await item.client.auth.getSession()).data.session!)).error) throw new Error("Native session transport failed");
  try {
    const first = value(await reconcileSourceUpload(item.client, item.identity));
    const attempt = { ...item.identity, expectedAttemptId: first.attemptId };
    value(await appendSourceUpload(item.client, { ...attempt, offset: 0, bytes: item.file.bytes }));
    const held = gateway.holdNext("/rest/v1/rpc/source_upload_validation_input");
    const completing = completeSourceUpload(transport, worker.jobs, attempt, sourceUploadValidator(gateway.url));
    await held.started;
    try {
      value(await completeSourceUpload(item.client, worker.jobs, attempt));
      const { finishUploadBatch } = await import("@/application/upload-batches");
      value(await finishUploadBatch(item.client, item.identity.batchId));
      await runSourceUploadCleanupTick(systemClient());
    } finally { held.release(); }
    expect(await completing).toEqual({ ok: true, value: { id: item.file.sourceFileId } });
    expect((await readSourceFile(item.client, item.companyId, item.file.sourceFileId))?.bytes).toEqual(item.file.bytes);
  } finally { gateway.close(); }
});

it("denies foreign authenticated reads and writes to private cleanup receipts and worker operations", async () => {
  const item = await pendingUpload();
  const foreign = await administratorWithCompany();
  const { cancelSourceUpload } = await import("@/application/source-upload-transfers");
  const { Client } = await import("pg");
  const first = value(await reconcileSourceUpload(item.client, item.identity));
  value(await cancelSourceUpload(item.client, { ...item.identity, expectedAttemptId: first.attemptId }));
  const session = (await foreign.client.auth.getSession()).data.session!;
  const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString());
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    for (const sql of ["select * from private.source_upload_cleanup where attempt_id=$1", "update private.source_upload_cleanup set last_swept_at=now() where attempt_id=$1"]) {
      await database.query("begin");
      await database.query("set local role authenticated");
      await database.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      await expect(database.query(sql, [first.attemptId])).rejects.toMatchObject({ code: "42501" });
      await database.query("rollback");
    }
  } finally { await database.end(); }
  expect((await foreign.client.rpc("retire_source_uploads")).error?.code).toBe("42501");
  expect((await foreign.client.rpc("source_upload_cleanup_candidates")).error?.code).toBe("42501");
  expect((await foreign.client.rpc("finish_source_upload_cleanup_sweep", { target_attempt_id: first.attemptId! })).error?.code).toBe("42501");
});

it("restricts worker transport mutations to the granted lifecycle operations", async () => {
  const item = await pendingUpload();
  const first = value(await reconcileSourceUpload(item.client, item.identity));
  const worker = systemClient();
  expect((await worker.from("source_upload_transfer").update({ confirmed_bytes: 0 }).eq("source_file_id", item.file.sourceFileId)).error?.code).toBe("42501");
  expect((await worker.from("source_upload_chunk").insert({ source_file_id: item.file.sourceFileId, attempt_id: first.attemptId!, company_id: item.companyId,
    organization_id: item.organizationId, byte_offset: 0, byte_size: 1, sha256: "a".repeat(64) })).error?.code).toBe("42501");
  expect((await worker.rpc("retire_source_uploads")).error).toBeNull();
  expect((await worker.rpc("source_upload_cleanup_candidates")).error).toBeNull();
});
