import { expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { beginUploadBatch } from "@/application/upload-batches";
import { appendSourceUpload } from "@/application/source-upload-transfers";
import { readSourceFile } from "@/application/source-files";
import { listCompanyDocuments } from "@/application/documents";
import { administratorWithCompany, assignAiConfigurationFixture } from "../tests/support/fixtures";
import { selectFixtureFiles } from "../tests/support/files";
import { sourceUploadAttempt } from "../tests/support/source-upload";
import { httpAs, value } from "./support/http";

it("serves an owned recovery manifest and resumes only confirmed remaining bytes after native reauthentication", async () => {
  const owner = await administratorWithCompany();
  const foreign = await administratorWithCompany();
  value(await assignAiConfigurationFixture(owner.client, { async send() {} }, { companyId: owner.companyId, provider: { name: "fake", region: "local" } }));
  const { files: [file], selectedFiles } = selectFixtureFiles("receipt.png");
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles }));
  const attempt = await sourceUploadAttempt(owner.client, { companyId: owner.companyId, batchId: batch.id, sourceFileId: file.sourceFileId,
    fileName: "pinned-recovery.png", byteSize: file.bytes.length, sha256: selectedFiles[0].sha256 });
  value(await appendSourceUpload(owner.client, { ...attempt, offset: 0, bytes: file.bytes.slice(0, 20) }));
  const { logOut, logIn } = await import("@/application/auth");
  await logOut(owner.client);
  value(await logIn(owner.client, { email: owner.email, password: "correct-horse-battery" }));
  const request = await httpAs(owner.client);
  const recoveryPath = `/companies/${owner.companyId}/upload?resumeBatchId=${batch.id}`;
  const page = await request(recoveryPath);
  expect(page.status).toBe(200);
  expect((await page.text()).includes("pinned-recovery.png")).toBe(true);
  const foreignRequest = await httpAs(foreign.client);
  expect((await foreignRequest(recoveryPath)).status).toBe(404);
  const path = `/companies/${owner.companyId}/source-files/${file.sourceFileId}/transfer`;
  const identity = { batchId: attempt.batchId, fileName: attempt.fileName, byteSize: attempt.byteSize, sha256: attempt.sha256, expectedAttemptId: attempt.expectedAttemptId };
  const reconciled = await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(identity) });
  expect((await reconciled.json()).value).toEqual({ attemptId: attempt.expectedAttemptId, byteSize: file.bytes.length, confirmedBytes: 20, complete: false });
  const appended = await request(path, { method: "PUT", headers: { "Upload-Batch-Id": batch.id,
    "Upload-File-Name": "pinned-recovery.png", "Upload-Byte-Size": String(file.bytes.length), "Upload-Sha256": selectedFiles[0].sha256,
    "Upload-Attempt-Id": attempt.expectedAttemptId!, "Upload-Offset": "20" }, body: Buffer.from(file.bytes.slice(20)) });
  expect(appended.status).toBe(200);
  const completed = await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...identity, complete: true }) });
  expect(completed.status).toBe(201);
  const stored = await readSourceFile(owner.client, owner.companyId, file.sourceFileId);
  expect(stored?.bytes).toEqual(file.bytes);
  expect(stored?.file.fileName).toBe("pinned-recovery.png");
  expect(stored?.file.sha256).toBe("c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77");
  const deadline = Date.now() + 15000;
  let documents = await listCompanyDocuments(owner.client, owner.companyId);
  while (documents[0]?.status !== "needs_review" && Date.now() < deadline) { await delay(50); documents = await listCompanyDocuments(owner.client, owner.companyId); }
  expect(documents).toHaveLength(1);
  expect(documents[0].status).toBe("needs_review");
});
