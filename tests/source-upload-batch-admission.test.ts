import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { expect, inject, it } from "vitest";
import { asUserClient } from "@/application/client";
import type { Database } from "@/lib/database.types";
import { uploadSourceFile, readSourceFile } from "@/application/source-files";
import { finishUploadBatch, deleteUploadBatch } from "@/application/upload-batches";
import { runSourceUploadCleanupTick } from "@/application/source-upload-cleanup";
import { administratorWithCompany, legacyUploadBatchFixture } from "./support/fixtures";
import { heicFixture } from "./support/files";
import { systemClient, testWorker } from "./support/worker";
import { sourceUploadValidator } from "./support/source-upload";
import { supabaseHttpGateway } from "./support/supabase-http-gateway";
import { delayedTemporaryWrite } from "./support/upload-lifecycle";

function value<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

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
