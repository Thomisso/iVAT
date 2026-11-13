import { expect, inject, it } from "vitest";
import { beginUploadBatch, finishUploadBatch, deleteUploadBatch } from "@/application/upload-batches";
import { reconcileSourceUpload, appendSourceUpload } from "@/application/source-upload-transfers";
import { getUploadLimits, readSourceFile, uploadSourceFile } from "@/application/source-files";
import { setPlatformUploadLimits } from "@/application/platform-administration";
import { runSourceUploadCleanupTick } from "@/application/source-upload-cleanup";
import { administratorWithCompany, assignAiConfigurationFixture } from "./support/fixtures";
import { selectFixtureFiles, selectUploadFiles, heicFixture } from "./support/files";
import { systemClient, testWorker } from "./support/worker";
import { sourceUploadValidator, completeSourceUpload } from "./support/source-upload";
import { supabaseHttpGateway } from "./support/supabase-http-gateway";
import { delayedTemporaryWrite } from "./support/upload-lifecycle";
import { promotedSuperAdministrator } from "./support/platform";

function value<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

it("returns a refusal when an ordinary Batch finishes after claim admission and before validator input", async () => {
  const owner = await administratorWithCompany(), selection = selectFixtureFiles("receipt.png"), file = selection.files[0];
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles: selection.selectedFiles }));
  const gateway = await supabaseHttpGateway(inject("supabaseUrl")), held = gateway.holdNext("/rest/v1/rpc/source_upload_validation_input");
  const worker = testWorker(), pending = uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.id, ...file }, sourceUploadValidator(gateway.url));
  await held.started;
  try { value(await finishUploadBatch(owner.client, batch.id)); }
  finally { held.release(); }
  try {
    expect(await pending).toEqual({ ok: false, error: "forbidden" });
    expect(worker.queued).toEqual([]);
  } finally { gateway.close(); }
});

it("collects a concurrent validator's objects committed after the published Batch was authorized for deletion and an empty sweep", async () => {
  const owner = await administratorWithCompany(), bytes = heicFixture(), selection = selectUploadFiles([{ fileName: "late.heic", bytes }]), file = selection.files[0], worker = testWorker();
  value(await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai }));
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles: selection.selectedFiles }));
  const identity = { companyId: owner.companyId, batchId: batch.id, sourceFileId: file.sourceFileId, fileName: file.fileName, byteSize: bytes.length, sha256: selection.selectedFiles[0].sha256 };
  const first = value(await reconcileSourceUpload(owner.client, identity)), attempt = { ...identity, expectedAttemptId: first.attemptId };
  value(await appendSourceUpload(owner.client, { ...attempt, offset: 0, bytes }));
  const gateway = await supabaseHttpGateway(inject("supabaseUrl")), held = gateway.holdNext("/storage/v1/object/source-files/"), lateWorker = testWorker();
  const late = completeSourceUpload(owner.client, lateWorker.jobs, attempt, sourceUploadValidator(gateway.url));
  await held.started;
  const prefix = `${owner.companyId}/${file.sourceFileId}/transfer/${first.attemptId}`, system = systemClient();
  try {
    value(await completeSourceUpload(owner.client, worker.jobs, attempt));
    expect(await worker.runJobsConcurrently()).toEqual([]);
    value(await finishUploadBatch(owner.client, batch.id));
    value(await deleteUploadBatch(owner.client, { companyId: owner.companyId, batchId: batch.id }));
    await runSourceUploadCleanupTick(system);
    expect((await system.storage.from("source-files").list(prefix)).data).toEqual([]);
    await delayedTemporaryWrite(`${prefix}/original`, () => { held.release(); return late; }, async finish => {
      // This sweep cannot see the provider's admitted, uncommitted original.
      await runSourceUploadCleanupTick(system);
      expect((await system.storage.from("source-files").list(prefix)).data).toEqual([]);
      expect(await finish()).toEqual({ ok: false, error: "forbidden" });
      expect(lateWorker.queued).toEqual([]);
      expect((await system.storage.from("source-files").list(prefix)).data?.map(object => object.name).sort()).toEqual(["normalized.jpeg", "original"]);
      await runSourceUploadCleanupTick(system);
      expect((await system.storage.from("source-files").list(prefix)).data).toEqual([]);
      expect(await readSourceFile(owner.client, owner.companyId, file.sourceFileId)).toBeNull();
    }, "source-files");
  } finally {
    held.release();
    await Promise.allSettled([late]);
    gateway.close();
  }
});

it("preserves unexpected ordinary validation provider failures while native authority is still current", async () => {
  const owner = await administratorWithCompany(), selection = selectFixtureFiles("receipt.png");
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles: selection.selectedFiles }));
  const gateway = await supabaseHttpGateway(inject("supabaseUrl")), worker = testWorker();
  gateway.unavailable(true, "/rest/v1/rpc/source_upload_validation_input");
  try {
    await expect(uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.id, ...selection.files[0] }, sourceUploadValidator(gateway.url))).rejects.toMatchObject({ message: "Dependency unavailable" });
    expect(worker.queued).toEqual([]);
  } finally { gateway.close(); }
});

it("returns the current ordinary page limit refusal when limits change before factual validation is recorded", async () => {
  const owner = await administratorWithCompany(), platform = await promotedSuperAdministrator("Ordinary validation limits"), selection = selectFixtureFiles("two-invoices.pdf");
  const previous = await getUploadLimits(owner.client);
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles: selection.selectedFiles }));
  const gateway = await supabaseHttpGateway(inject("supabaseUrl")), held = gateway.holdNext("/rest/v1/rpc/record_source_upload_validation"), worker = testWorker();
  const pending = uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.id, ...selection.files[0] }, sourceUploadValidator(gateway.url));
  await held.started;
  try {
    value(await setPlatformUploadLimits(platform.client, { ...previous, maxFilePages: 1 }));
    held.release();
    expect(await pending).toEqual({ ok: false, error: "too_many_pages" });
    expect(worker.queued).toEqual([]);
  } finally {
    held.release();
    await Promise.allSettled([pending]);
    value(await setPlatformUploadLimits(platform.client, previous));
    gateway.close();
  }
});

it("converges ordinary validation to the same published Source after its Batch finishes", async () => {
  const owner = await administratorWithCompany(), selection = selectFixtureFiles("receipt.png"), worker = testWorker(), lateWorker = testWorker();
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles: selection.selectedFiles }));
  const input = { companyId: owner.companyId, batchId: batch.id, ...selection.files[0] };
  const gateway = await supabaseHttpGateway(inject("supabaseUrl")), held = gateway.holdNext("/rest/v1/rpc/source_upload_validation_input");
  const late = uploadSourceFile(owner.client, lateWorker.jobs, input, sourceUploadValidator(gateway.url));
  await held.started;
  try {
    const published = value(await uploadSourceFile(owner.client, worker.jobs, input, sourceUploadValidator()));
    value(await finishUploadBatch(owner.client, batch.id));
    held.release();
    expect(await late).toEqual({ ok: true, value: published });
    expect(lateWorker.queued).toHaveLength(1);
  } finally {
    held.release();
    await Promise.allSettled([late]);
    gateway.close();
  }
});
