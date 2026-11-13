import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { beginUploadBatch, finishUploadBatch, getUploadBatch, listUploadBatches } from "@/application/upload-batches";
import { uploadSourceFile } from "./support/source-upload";
import { administratorWithCompany, companyMember, legacyUploadBatchFixture } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";

describe("Upload Batch frozen manifest boundary", () => {
  it("refuses every new manifest-less application batch, with or without a requested UUID, without creating history", async () => {
    const owner = await administratorWithCompany();
    const results = await Promise.all([
      beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1 }),
      beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, batchId: randomUUID() }),
    ]);
    expect(results).toEqual([{ ok: false, error: "invalid_choice" }, { ok: false, error: "invalid_choice" }]);
    expect(await listUploadBatches(owner.client, owner.companyId)).toEqual([]);
  });

  it.each([false, true])("refuses a direct authenticated RPC without a manifest (requested UUID: %s), without creating history", async (requested) => {
    const owner = await administratorWithCompany();
    const result = await owner.client.rpc("begin_upload_batch", {
      target_company_id: owner.companyId, selected_file_count: 1,
      ...(requested ? { requested_batch_id: randomUUID(), selected_files: null } : {}),
    });
    expect(result.error).toEqual(expect.objectContaining({ code: "P0001", hint: "invalid_choice" }));
    expect(await listUploadBatches(owner.client, owner.companyId)).toEqual([]);
    const insert = await owner.client.from("upload_batch").insert({
      organization_id: owner.organizationId, company_id: owner.companyId, created_by: owner.userId, file_count: 1,
    });
    expect(insert.error?.code).toBe("42501");
    expect(await listUploadBatches(owner.client, owner.companyId)).toEqual([]);
  });

  it("refuses identical selected content through both creation interfaces without creating a Batch", async () => {
    const owner = await administratorWithCompany();
    const selectedFiles = [randomUUID(), randomUUID()].map((id) => ({ id, sha256: "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77" }));
    expect(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles })).toEqual({ ok: false, error: "identical_file" });
    const result = await owner.client.rpc("begin_upload_batch", { target_company_id: owner.companyId, selected_file_count: 2, selected_files: selectedFiles });
    expect(result.error).toEqual(expect.objectContaining({ code: "P0001", hint: "identical_file" }));
    expect(await listUploadBatches(owner.client, owner.companyId)).toEqual([]);
  });

  it("retains only the authorized same-ID/count retry of an existing legacy Batch, including its Source Files and completed retry", async () => {
    const owner = await administratorWithCompany();
    const colleague = await companyMember(owner);
    const other = await administratorWithCompany();
    const batchId = await legacyUploadBatchFixture(owner, 2);
    const input = { companyId: owner.companyId, fileCount: 2, batchId };
    expect(await beginUploadBatch(owner.client, input)).toEqual({ ok: true, value: { id: batchId } });
    const retry = await owner.client.rpc("begin_upload_batch", { target_company_id: owner.companyId, selected_file_count: 2, requested_batch_id: batchId });
    expect(retry.error).toBeNull();
    expect(retry.data).toBe(batchId);
    expect(await beginUploadBatch(owner.client, { ...input, fileCount: 1 })).toEqual({ ok: false, error: "invalid_choice" });
    expect(await beginUploadBatch(colleague.client, input)).toEqual({ ok: false, error: "forbidden" });
    expect(await beginUploadBatch(other.client, input)).toEqual({ ok: false, error: "forbidden" });
    expect(await beginUploadBatch(other.client, { ...input, companyId: other.companyId })).toEqual({ ok: false, error: "forbidden" });
    const worker = testWorker();
    for (const fileName of ["receipt.png", "two-invoices.pdf"]) {
      expect((await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, batchId, fileName, bytes: fixtureFile(fileName) })).ok).toBe(true);
    }
    expect(await finishUploadBatch(owner.client, batchId)).toEqual({ ok: true, value: null });
    expect(await beginUploadBatch(owner.client, input)).toEqual({ ok: true, value: { id: batchId } });
    expect(await getUploadBatch(owner.client, owner.companyId, batchId)).toEqual(expect.objectContaining({ plannedFileCount: 2, actualFileCount: 2, uploadFinishedAt: expect.any(String) }));
    expect(await listUploadBatches(owner.client, owner.companyId)).toHaveLength(1);
  });

  it("never treats a current frozen Batch as a legacy count-only retry", async () => {
    const owner = await administratorWithCompany();
    const batchId = randomUUID();
    const input = { companyId: owner.companyId, fileCount: 1, batchId };
    const selectedFiles = [{ id: randomUUID(), sha256: "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77" }];
    expect(await beginUploadBatch(owner.client, { ...input, selectedFiles })).toEqual({ ok: true, value: { id: batchId } });
    expect(await beginUploadBatch(owner.client, input)).toEqual({ ok: false, error: "invalid_choice" });
    const retry = await owner.client.rpc("begin_upload_batch", { target_company_id: owner.companyId, selected_file_count: 1, requested_batch_id: batchId, selected_files: null });
    expect(retry.error).toEqual(expect.objectContaining({ code: "P0001", hint: "invalid_choice" }));
    expect(await listUploadBatches(owner.client, owner.companyId)).toHaveLength(1);
  });
});
