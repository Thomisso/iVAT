import { describe, expect, it } from "vitest";
import {
  beginUploadBatch,
  finishUploadBatch,
  listUploadNotifications,
} from "@/application/upload-batches";
import { uploadSourceFile } from "@/application/source-files";
import { enableAiProcessing } from "@/application/companies";
import { administratorWithCompany } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";
import { fakeAiProvider } from "@/ai/fake";

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
        createdAt: expect.any(String),
      },
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

  it("notifies after a technical failure reaches its final state", async () => {
    const { client, companyId } = await administratorWithCompany();
    const worker = testWorker(
      fakeAiProvider({
        split() {
          throw new Error("provider unavailable");
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
      }),
    ]);
  });
});
