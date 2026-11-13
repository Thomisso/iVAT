import { sourceUploadAttempt } from "../tests/support/source-upload";
import { Client } from "pg";
import { expect, inject, it } from "vitest";
import { beginUploadBatch } from "@/application/upload-batches";
import { appendSourceUpload } from "@/application/source-upload-transfers";
import { getSourceFile, readSourceFile } from "@/application/source-files";
import { administratorWithCompany, assignAiConfigurationFixture } from "../tests/support/fixtures";
import { selectFixtureFiles } from "../tests/support/files";
import { httpAs, value } from "./support/http";

it("refuses expired HTTP continuation and explicitly restarts the unchanged item through durable processing", async () => {
  const owner = await administratorWithCompany();
  value(await assignAiConfigurationFixture(owner.client, { async send() {} }, { companyId: owner.companyId, provider: { name: "fake", region: "local" } }));
  const { files: [file], selectedFiles } = selectFixtureFiles("receipt.png");
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles }));
  const identity = await sourceUploadAttempt(owner.client, { companyId: owner.companyId, sourceFileId: file.sourceFileId, batchId: batch.id,
    fileName: file.fileName, byteSize: file.bytes.length, sha256: selectedFiles[0].sha256 });
  value(await appendSourceUpload(owner.client, { ...identity, offset: 0, bytes: file.bytes.slice(0, 20) }));
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query("update public.source_upload_transfer set last_progress_at = clock_timestamp() - interval '7 days 1 second' where source_file_id = $1", [file.sourceFileId]);
  } finally { await database.end(); }
  const request = await httpAs(owner.client);
  const response = await request(`/companies/${owner.companyId}/source-files/${file.sourceFileId}/transfer`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(identity),
  });
  expect(response.status).toBe(410);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: false, error: "upload_expired", attemptId: identity.expectedAttemptId });
  expect(await getSourceFile(owner.client, owner.companyId, file.sourceFileId)).toBeNull();
  const path = `/companies/${owner.companyId}/source-files/${file.sourceFileId}/transfer`;
  const command = (input: object) => request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...identity, ...input }) });
  const restart = await command({ restart: true });
  expect(restart.status).toBe(200);
  const replacement = (await restart.json()).value;
  expect(replacement.confirmedBytes).toBe(0);
  expect(replacement.attemptId).not.toBe(identity.expectedAttemptId);
  const stale = await command({ complete: true });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ ok: false, error: "upload_attempt_changed" });
  const uploaded = await request(path, { method: "PUT", headers: {
    "Upload-Batch-Id": batch.id, "Upload-File-Name": encodeURIComponent(file.fileName), "Upload-Byte-Size": String(file.bytes.length),
    "Upload-Sha256": identity.sha256, "Upload-Offset": "0", "Upload-Attempt-Id": replacement.attemptId,
  }, body: Buffer.from(file.bytes) });
  expect(uploaded.status).toBe(200);
  expect((await uploaded.json()).value.confirmedBytes).toBe(file.bytes.length);
  expect((await command({ restart: true })).status).toBe(200);
  expect((await command({ expectedAttemptId: replacement.attemptId, complete: true })).status).toBe(201);
  expect((await command({ complete: true })).status).toBe(409);
  const stored = await readSourceFile(owner.client, owner.companyId, file.sourceFileId);
  expect(stored?.bytes).toEqual(file.bytes);
  expect(stored?.file.sha256).toBe("c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77");
  const { listCompanyDocuments, listExtractionVersions } = await import("@/application/documents");
  const { setTimeout: delay } = await import("node:timers/promises");
  const deadline = Date.now() + 15_000;
  let documents = await listCompanyDocuments(owner.client, owner.companyId);
  while (documents[0]?.status !== "needs_review" && Date.now() < deadline) {
    await delay(50);
    documents = await listCompanyDocuments(owner.client, owner.companyId);
  }
  expect((await getSourceFile(owner.client, owner.companyId, file.sourceFileId))?.status).toBe("split");
  expect(documents).toHaveLength(1);
  expect(documents[0].status).toBe("needs_review");
  expect(await listExtractionVersions(owner.client, owner.companyId, documents[0].id)).toHaveLength(1);
});

it("cancels through authenticated HTTP and observes the real worker remove temporary bytes", async () => {
  const owner = await administratorWithCompany();
  const request = await httpAs(owner.client);
  const { files: [file], selectedFiles } = selectFixtureFiles("receipt.png");
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles }));
  const identity = { batchId: batch.id, fileName: file.fileName, byteSize: file.bytes.length, sha256: selectedFiles[0].sha256 };
  const path = `/companies/${owner.companyId}/source-files/${file.sourceFileId}/transfer`;
  const command = (input: object) => request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...identity, ...input }) });
  const first = (await (await command({})).json()).value;
  const portion = await request(path, { method: "PUT", headers: {
    "Upload-Batch-Id": batch.id, "Upload-File-Name": encodeURIComponent(file.fileName), "Upload-Byte-Size": String(file.bytes.length),
    "Upload-Sha256": identity.sha256, "Upload-Offset": "0", "Upload-Attempt-Id": first.attemptId,
  }, body: Buffer.from(file.bytes.slice(0, 20)) });
  expect(portion.status).toBe(200);
  const { systemClient } = await import("../tests/support/worker");
  const system = systemClient();
  const prefix = `${owner.companyId}/${file.sourceFileId}/${first.attemptId}/0`;
  expect((await system.storage.from("source-upload-chunks").list(prefix)).data).toHaveLength(1);
  expect((await command({ expectedAttemptId: first.attemptId, cancel: true })).status).toBe(200);
  const cancelled = await command({});
  expect(cancelled.status).toBe(410);
  expect(await cancelled.json()).toEqual({ ok: false, error: "upload_cancelled", attemptId: first.attemptId });
  const { setTimeout: delay } = await import("node:timers/promises");
  const deadline = Date.now() + 45_000;
  let objects = await system.storage.from("source-upload-chunks").list(prefix);
  while (objects.data?.length && Date.now() < deadline) {
    await delay(100);
    objects = await system.storage.from("source-upload-chunks").list(prefix);
  }
  expect(objects.error).toBeNull();
  expect(objects.data).toEqual([]);
  expect(await getSourceFile(owner.client, owner.companyId, file.sourceFileId)).toBeNull();
});
