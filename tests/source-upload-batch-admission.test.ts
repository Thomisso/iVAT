import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { expect, inject, it } from "vitest";
import { asUserClient } from "@/application/client";
import type { Database } from "@/lib/database.types";
import { uploadSourceFile, readSourceFile } from "@/application/source-files";
import { beginUploadBatch, finishUploadBatch, deleteUploadBatch, getUploadBatch } from "@/application/upload-batches";
import { setOrganizationMfaRequired } from "@/application/mfa";
import { runSourceUploadCleanupTick } from "@/application/source-upload-cleanup";
import { administratorWithCompany, companyMember, legacyUploadBatchFixture } from "./support/fixtures";
import { heicFixture, selectFixtureFiles } from "./support/files";
import { systemClient, testWorker } from "./support/worker";
import { sourceUploadValidator } from "./support/source-upload";
import { supabaseHttpGateway } from "./support/supabase-http-gateway";
import { delayedTemporaryWrite } from "./support/upload-lifecycle";

function value<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

it("returns invalid_choice for an authorized unselected Source UUID before writing bytes and retains the frozen selection", async () => {
  const owner = await administratorWithCompany(), selection = selectFixtureFiles("receipt.png"), file = selection.files[0];
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles: selection.selectedFiles }));
  const replacementId = randomUUID(), worker = testWorker(), system = systemClient();
  expect(await uploadSourceFile(owner.client, worker.jobs, {
    companyId: owner.companyId, batchId: batch.id, ...file, sourceFileId: replacementId,
  }, sourceUploadValidator())).toEqual({ ok: false, error: "invalid_choice" });
  expect(worker.queued).toEqual([]);
  expect((await getUploadBatch(owner.client, owner.companyId, batch.id))?.actualFileCount).toBe(0);
  expect((await system.storage.from("source-files").download(`${owner.companyId}/${replacementId}`)).error).not.toBeNull();
  expect((await system.storage.from("source-files").list(`${owner.companyId}/${replacementId}`)).data).toEqual([]);
  value(await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId: batch.id, ...file }, sourceUploadValidator()));
  expect((await readSourceFile(owner.client, owner.companyId, file.sourceFileId))?.bytes).toEqual(file.bytes);
});

it("keeps unselected identity details forbidden to foreign, noncreator and MFA-refused native clients", async () => {
  const owner = await administratorWithCompany(), foreign = await administratorWithCompany(), member = await companyMember(owner), selection = selectFixtureFiles("receipt.png");
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles: selection.selectedFiles }));
  const replacementId = randomUUID(), file = selection.files[0], worker = testWorker();
  const args = { target_company_id: owner.companyId, target_batch_id: batch.id, target_source_file_id: replacementId,
    original_file_name: file.fileName, original_byte_size: file.bytes.length, original_sha256: selection.selectedFiles[0].sha256 };
  const input = { companyId: owner.companyId, batchId: batch.id, ...file, sourceFileId: replacementId };
  for (const client of [foreign.client, member.client]) {
    expect((await client.rpc("begin_source_file_validation", args)).error?.code).toBe("42501");
    expect(await uploadSourceFile(client, worker.jobs, input, sourceUploadValidator())).toEqual({ ok: false, error: "forbidden" });
  }
  value(await setOrganizationMfaRequired(owner.client, { organizationId: owner.organizationId, required: true }));
  expect((await owner.client.rpc("begin_source_file_validation", args)).error?.code).toBe("42501");
  expect(await uploadSourceFile(owner.client, worker.jobs, input, sourceUploadValidator())).toEqual({ ok: false, error: "forbidden" });
  expect(worker.queued).toEqual([]);
  expect((await systemClient().storage.from("source-files").download(`${owner.companyId}/${replacementId}`)).error).not.toBeNull();
});

it.each(["finish", "delete"] as const)("owns a historical count-only Batch upload before its first Storage write when %s wins admission", async action => {
  const owner = await administratorWithCompany(), batchId = await legacyUploadBatchFixture(owner, 1), sourceFileId = randomUUID();
  const gateway = await supabaseHttpGateway(inject("supabaseUrl"));
  const client = asUserClient(createClient<Database>(gateway.url, inject("supabaseAnonKey"), { auth: { persistSession: false, autoRefreshToken: false } }));
  if ((await client.auth.setSession((await owner.client.auth.getSession()).data.session!)).error) throw new Error("Native session transport failed");
  const held = gateway.holdNext("/rest/v1/rpc/begin_source_file_validation"), worker = testWorker();
  const pending = uploadSourceFile(client, worker.jobs, { companyId: owner.companyId, batchId, sourceFileId, fileName: "historical.heic", bytes: heicFixture() }, sourceUploadValidator());
  await held.started;
  try {
    value(await finishUploadBatch(owner.client, batchId));
    if (action === "delete") value(await deleteUploadBatch(owner.client, { companyId: owner.companyId, batchId }));
    held.release();
    expect(await pending).toEqual({ ok: false, error: "forbidden" });
    expect(worker.queued).toEqual([]);
    await runSourceUploadCleanupTick(systemClient());
    expect((await systemClient().storage.from("source-files").list(`${owner.companyId}/${sourceFileId}`)).data).toEqual([]);
    expect((await systemClient().storage.from("source-files").download(`${owner.companyId}/${sourceFileId}`)).error).not.toBeNull();
    expect(await readSourceFile(owner.client, owner.companyId, sourceFileId)).toBeNull();
  } finally {
    held.release();
    await Promise.allSettled([pending]);
    gateway.close();
  }
});

it.each([
  { action: "finish", part: "original" }, { action: "delete", part: "original" },
  { action: "finish", part: "derivative" }, { action: "delete", part: "derivative" },
])("collects an admitted historical count-only HEIC $part committed after $action and an empty cleanup sweep", async ({ action, part }) => {
  const owner = await administratorWithCompany(), batchId = await legacyUploadBatchFixture(owner, 1), sourceFileId = randomUUID(), bytes = heicFixture();
  const worker = testWorker(), system = systemClient(), path = `${owner.companyId}/${sourceFileId}`;
  await delayedTemporaryWrite(part === "original" ? path : `${path}/normalized.jpeg`, () => uploadSourceFile(owner.client, worker.jobs, {
    companyId: owner.companyId, batchId, sourceFileId, fileName: "late-historical.heic", bytes,
  }, sourceUploadValidator()), async finish => {
    value(await finishUploadBatch(owner.client, batchId));
    if (action === "delete") value(await deleteUploadBatch(owner.client, { companyId: owner.companyId, batchId }));
    await runSourceUploadCleanupTick(system);
    expect((await system.storage.from("source-files").download(path)).error).not.toBeNull();
    expect((await system.storage.from("source-files").list(path)).data).toEqual([]);
    expect(await finish()).toEqual({ ok: false, error: "forbidden" });
    expect(worker.queued).toEqual([]);
    // This is the final provider INSERT, after both rolled-back permission
    // probes: the canonical object really committed after the empty sweep.
    if (part === "original") {
      const stored = await system.storage.from("source-files").download(path);
      expect(stored.error).toBeNull();
      expect(new Uint8Array(await stored.data!.arrayBuffer())).toEqual(bytes);
    } else {
      expect((await system.storage.from("source-files").list(path)).data?.map(object => object.name)).toEqual(["normalized.jpeg"]);
    }
    await runSourceUploadCleanupTick(system);
    expect((await system.storage.from("source-files").list(path)).data).toEqual([]);
    expect((await system.storage.from("source-files").download(path)).error).not.toBeNull();
    expect(await readSourceFile(owner.client, owner.companyId, sourceFileId)).toBeNull();
  }, "source-files", 2);
});
