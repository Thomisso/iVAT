import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { beginUploadBatch } from "@/application/upload-batches";
import { getSourceFile, readSourceFile } from "@/application/source-files";
import { administratorWithCompany, assignAiConfigurationFixture } from "../tests/support/fixtures";
import { selectFixtureFiles } from "../tests/support/files";
import { httpAs, value } from "./support/http";

it("reconciles real interrupted HTTP bytes and retries a lost completion response", async () => {
  const owner = await administratorWithCompany();
  const request = await httpAs(owner.client);
  value(await assignAiConfigurationFixture(owner.client, { async send() {} }, { companyId: owner.companyId, provider: { name: "fake", region: "local" } }));
  const { files: [file], selectedFiles } = selectFixtureFiles("receipt.png");
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles }));
  const identity = { batchId: batch.id, fileName: file.fileName, byteSize: file.bytes.length, sha256: selectedFiles[0].sha256 };
  const path = `/companies/${owner.companyId}/source-files/${file.sourceFileId}/transfer`;
  const reconcile = () => request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(identity) });
  const append = (offset: number, bytes: Uint8Array) => request(path, { method: "PUT", headers: {
    "Upload-Batch-Id": batch.id, "Upload-File-Name": encodeURIComponent(file.fileName), "Upload-Byte-Size": String(file.bytes.length),
    "Upload-Sha256": selectedFiles[0].sha256, "Upload-Offset": String(offset),
  }, body: Buffer.from(bytes) });
  const started = await reconcile();
  expect(started.status).toBe(200);
  expect(await started.json()).toEqual({ ok: true, value: { confirmedBytes: 0, byteSize: file.bytes.length, complete: false } });
  const portion = await append(0, file.bytes.slice(0, 20));
  expect(portion.status).toBe(200);
  // Lose the first response body and obtain confirmation from the server again.
  expect((await (await reconcile()).json()).value.confirmedBytes).toBe(20);
  expect((await append(0, file.bytes.slice(0, 20))).status).toBe(200);
  expect((await append(20, file.bytes.slice(20))).status).toBe(200);
  const complete = () => request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...identity, complete: true }) });
  const responses = await Promise.all([complete(), complete()]);
  expect(responses.map(response => response.status)).toEqual([201, 201]);
  expect(await (await complete()).json()).toEqual({ ok: true, value: { id: file.sourceFileId } });
  const stored = await readSourceFile(owner.client, owner.companyId, file.sourceFileId);
  expect(stored?.bytes).toEqual(file.bytes);
  expect(stored?.file.sha256).toBe("c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77");
  const { listCompanyDocuments, listExtractionVersions } = await import("@/application/documents");
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

it("refuses anonymous, foreign-account and revoked-access continuation including direct transport calls", async () => {
  const { companyMember } = await import("../tests/support/fixtures");
  const { listAccessManagement, removeMembership } = await import("@/application/memberships");
  const { baseUrl } = await import("./support/http");
  const owner = await administratorWithCompany();
  const member = await companyMember(owner);
  const foreign = await administratorWithCompany();
  const { files: [file], selectedFiles } = selectFixtureFiles("receipt.png");
  const batch = value(await beginUploadBatch(member.client, { companyId: owner.companyId, fileCount: 1, selectedFiles }));
  const identity = { batchId: batch.id, fileName: file.fileName, byteSize: file.bytes.length, sha256: selectedFiles[0].sha256 };
  const path = `/companies/${owner.companyId}/source-files/${file.sourceFileId}/transfer`;
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(identity) };
  const request = await httpAs(member.client);
  expect((await request(path, init)).status).toBe(200);
  const anonymous = await fetch(new URL(path, baseUrl()), { ...init, redirect: "manual" });
  expect(anonymous.status).toBe(307);
  expect(anonymous.headers.get("location")).toContain("/login");
  const foreignRequest = await httpAs(foreign.client);
  expect((await foreignRequest(path, init)).status).toBe(403);
  const ownerRequest = await httpAs(owner.client);
  expect((await ownerRequest(path, init)).status).toBe(403);
  for (const table of ["source_upload_transfer", "source_upload_chunk"] as const) {
    expect((await foreign.client.from(table).select("source_file_id").eq("source_file_id", file.sourceFileId)).data).toEqual([]);
    expect((await foreign.client.from(table).delete().eq("source_file_id", file.sourceFileId)).error?.code).toBe("42501");
  }
  const management = value(await listAccessManagement(owner.client, { organizationId: owner.organizationId, companyId: owner.companyId }));
  const membership = management.users.find(user => user.userId === member.userId)!.memberships.find(item => item.companyId === owner.companyId)!;
  value(await removeMembership(owner.client, membership.id));
  expect((await request(path, init)).status).toBe(403);
  const direct = await member.client.rpc("confirm_source_upload_chunk", { target_source_file_id: file.sourceFileId, chunk_offset: 0, chunk_byte_size: 1, chunk_sha256: selectedFiles[0].sha256 });
  expect(direct.error?.code).toBe("42501");
  const stored = await member.client.storage.from("source-upload-chunks").upload(`${owner.companyId}/${file.sourceFileId}/0/${selectedFiles[0].sha256}`, new Uint8Array([1]), { contentType: "application/octet-stream" });
  expect(stored.error).not.toBeNull();
});

it("requires native reauthentication and MFA before the same account can continue confirmed bytes", async () => {
  const { beginTotpEnrollment, completeTotpEnrollment, verifyTotp } = await import("@/application/mfa");
  const { logIn, logOut } = await import("@/application/auth");
  const { totp } = await import("../tests/support/totp");
  const { reconcileSourceUpload, appendSourceUpload } = await import("@/application/source-upload-transfers");
  const owner = await administratorWithCompany();
  const { files: [file], selectedFiles } = selectFixtureFiles("receipt.png");
  const batch = value(await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles }));
  const identity = { companyId: owner.companyId, sourceFileId: file.sourceFileId, batchId: batch.id, fileName: file.fileName, byteSize: file.bytes.length, sha256: selectedFiles[0].sha256 };
  value(await appendSourceUpload(owner.client, { ...identity, offset: 0, bytes: file.bytes.slice(0, 20) }));
  const enrollment = value(await beginTotpEnrollment(owner.client));
  value(await completeTotpEnrollment(owner.client, { factorId: enrollment.factorId, code: totp(enrollment.secret) }));
  await logOut(owner.client);
  value(await logIn(owner.client, { email: owner.email, password: "correct-horse-battery" }));
  const request = await httpAs(owner.client);
  const path = `/companies/${owner.companyId}/source-files/${file.sourceFileId}/transfer`;
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(identity) };
  const refused = await request(path, init);
  expect(refused.status).toBe(307);
  expect(refused.headers.get("location")).toContain("/mfa/verify");
  expect(await reconcileSourceUpload(owner.client, identity)).toEqual({ ok: false, error: "forbidden" });
  value(await verifyTotp(owner.client, { factorId: enrollment.factorId, code: totp(enrollment.secret) }));
  const verified = await httpAs(owner.client);
  const resumed = await verified(path, init);
  expect(resumed.status).toBe(200);
  expect((await resumed.json()).value.confirmedBytes).toBe(20);
});
