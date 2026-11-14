import { expect, it } from "vitest";
import { beginUploadBatch } from "@/application/upload-batches";
import { getUploadBatchRecovery } from "@/application/source-upload-transfers";
import { appendSourceUpload } from "@/application/source-upload-transfers";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { selectFixtureFiles } from "./support/files";
import { sourceUploadAttempt } from "./support/source-upload";

it("recovers one owned frozen manifest with ordered groups and pinned attempt identity after all local metadata is lost", async () => {
  const owner = await administratorWithCompany();
  const colleague = await companyMember(owner);
  const foreign = await administratorWithCompany();
  const { files, selectedFiles } = selectFixtureFiles("receipt.png", "receipt.jpg");
  const groupId = crypto.randomUUID();
  const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles: selectedFiles.map(item => ({ ...item, groupId })) });
  if (!batch.ok) throw new Error(batch.error);
  const attempt = await sourceUploadAttempt(owner.client, { companyId: owner.companyId, batchId: batch.value.id, sourceFileId: files[0].sourceFileId,
    fileName: "pinned.png", byteSize: files[0].bytes.length, sha256: selectedFiles[0].sha256 });
  expect((await appendSourceUpload(owner.client, { ...attempt, offset: 0, bytes: files[0].bytes.slice(0, 20) })).ok).toBe(true);
  expect(await getUploadBatchRecovery(owner.client, owner.companyId, batch.value.id)).toEqual({ ok: true, value: {
    batchId: batch.value.id, plannedFileCount: 2, legacy: false, items: [
      { id: files[0].sourceFileId, sha256: selectedFiles[0].sha256, groupId, fileName: "pinned.png", byteSize: files[0].bytes.length, attemptId: attempt.expectedAttemptId, complete: false },
      { id: files[1].sourceFileId, sha256: selectedFiles[1].sha256, groupId, fileName: null, byteSize: null, complete: false },
    ],
  } });
  for (const user of [colleague, foreign]) expect(await getUploadBatchRecovery(user.client, owner.companyId, batch.value.id)).toEqual({ ok: false, error: "forbidden" });
  expect(await getUploadBatchRecovery(owner.client, foreign.companyId, batch.value.id)).toEqual({ ok: false, error: "forbidden" });
});

it("returns the whole selected manifest beyond the HTTP row cap and denies direct foreign recovery", async () => {
  const { withPostgrestRowLimit } = await import("./support/postgrest");
  const owner = await administratorWithCompany();
  const foreign = await administratorWithCompany();
  const { selectedFiles } = selectFixtureFiles("receipt.png", "receipt.jpg");
  const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles });
  if (!batch.ok) throw new Error(batch.error);
  const other = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles: selectFixtureFiles("receipt.jpg").selectedFiles });
  expect(other.ok).toBe(true);
  await withPostgrestRowLimit(1, () => owner.client.from("upload_batch").select("id").eq("company_id", owner.companyId), async () => {
    const recovered = await getUploadBatchRecovery(owner.client, owner.companyId, batch.value.id);
    expect(recovered.ok && recovered.value.items.map(item => item.id)).toEqual(selectedFiles.map(item => item.id));
  });
  expect((await foreign.client.rpc("get_upload_batch_recovery", { target_company_id: owner.companyId, target_batch_id: batch.value.id })).error?.code).toBe("42501");
});

it("rechecks current MFA and revoked Company access before exposing recovery metadata", async () => {
  const { listAccessManagement, removeMembership } = await import("@/application/memberships");
  const { beginTotpEnrollment, completeTotpEnrollment } = await import("@/application/mfa");
  const { logIn, logOut } = await import("@/application/auth");
  const { totp } = await import("./support/totp");
  const owner = await administratorWithCompany();
  const member = await companyMember(owner);
  const { selectedFiles } = selectFixtureFiles("receipt.png");
  const batch = await beginUploadBatch(member.client, { companyId: owner.companyId, fileCount: 1, selectedFiles });
  if (!batch.ok) throw new Error(batch.error);
  const management = await listAccessManagement(owner.client, { organizationId: owner.organizationId, companyId: owner.companyId });
  if (!management.ok) throw new Error(management.error);
  const membership = management.value.users.find(user => user.userId === member.userId)!.memberships.find(item => item.companyId === owner.companyId)!;
  expect((await removeMembership(owner.client, membership.id)).ok).toBe(true);
  expect(await getUploadBatchRecovery(member.client, owner.companyId, batch.value.id)).toEqual({ ok: false, error: "forbidden" });
  const owned = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles: selectFixtureFiles("receipt.png").selectedFiles });
  if (!owned.ok) throw new Error(owned.error);
  const enrollment = await beginTotpEnrollment(owner.client);
  if (!enrollment.ok) throw new Error(enrollment.error);
  expect((await completeTotpEnrollment(owner.client, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) })).ok).toBe(true);
  await logOut(owner.client);
  expect((await logIn(owner.client, { email: owner.email, password: "correct-horse-battery" })).ok).toBe(true);
  expect(await getUploadBatchRecovery(owner.client, owner.companyId, owned.value.id)).toEqual({ ok: false, error: "forbidden" });
});

it("does not invent missing identities for a historical count-only Batch or discard its stored evidence", async () => {
  const { legacyUploadBatchFixture } = await import("./support/fixtures");
  const { uploadSourceFile } = await import("./support/source-upload");
  const { fixtureFile } = await import("./support/files");
  const { readSourceFile } = await import("@/application/source-files");
  const { finishUploadBatch, getUploadBatch } = await import("@/application/upload-batches");
  const owner = await administratorWithCompany();
  const batchId = await legacyUploadBatchFixture(owner, 2);
  const original = await uploadSourceFile(owner.client, { async send() {} }, { companyId: owner.companyId, batchId, fileName: "retained.png", bytes: fixtureFile("receipt.png") });
  if (!original.ok) throw new Error(original.error);
  expect(await getUploadBatchRecovery(owner.client, owner.companyId, batchId)).toEqual({ ok: true, value: { batchId, plannedFileCount: 2, legacy: true, items: [] } });
  expect((await finishUploadBatch(owner.client, batchId)).ok).toBe(true);
  expect((await getUploadBatch(owner.client, owner.companyId, batchId))?.actualFileCount).toBe(1);
  expect((await readSourceFile(owner.client, owner.companyId, original.value.id))?.file.sha256).toBe("c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77");
  expect(await getUploadBatchRecovery(owner.client, owner.companyId, batchId)).toEqual({ ok: false, error: "forbidden" });
});
