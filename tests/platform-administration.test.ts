import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { inject, describe, expect, it } from "vitest";
import { fakeAiProvider } from "@/ai/fake";
import { asUserClient } from "@/application/client";
import { logIn } from "@/application/auth";
import { listAuditEvents } from "@/application/audit";
import { enableAiProcessing } from "@/application/companies";
import { listDocuments } from "@/application/documents";
import {
  listPlatformOrganizationCompanies,
  getPlatformUploadLimits,
  setPlatformUploadLimits,
  setPlatformOrganizationBlocked,
} from "@/application/platform-administration";
import {
  listFailedProcessingJobs,
  retryFailedProcessingJob,
} from "@/application/processing-administration";
import { listSourceFiles, uploadSourceFile } from "@/application/source-files";
import { beginUploadBatch } from "@/application/upload-batches";
import {
  createBoss,
  createProcessingQueues,
} from "@/lib/jobs";
import { administratorWithCompany } from "./support/fixtures";
import { anonymousClient, signedUpUser } from "./support/clients";
import { fixtureFile } from "./support/files";
import { systemClient, testWorker } from "./support/worker";

function aal2Client(userId: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    aud: "authenticated",
    exp: now + 3600,
    iat: now,
    sub: userId,
    role: "authenticated",
    aal: "aal2",
    session_id: `platform-administration-test-${userId}`,
  })}`;
  const signature = createHmac("sha256", inject("supabaseJwtSecret")).update(unsigned).digest("base64url");
  return asUserClient(createClient(inject("supabaseUrl"), inject("supabaseAnonKey"), {
    accessToken: async () => `${unsigned}.${signature}`,
    auth: { persistSession: false, autoRefreshToken: false },
  }));
}

async function superAdministrator() {
  const user = await signedUpUser("Platform Administration");
  const { error } = await systemClient().from("platform_user").insert({
    user_id: user.userId,
    role: "super_admin",
  });
  if (error) throw error;
  return { ...user, client: aal2Client(user.userId) };
}

describe("SuperAdmin organization console", () => {
  it("lists every Organization and Company only for a SuperAdmin", async () => {
    const target = await administratorWithCompany("Accounting Office");
    const ordinary = await signedUpUser("Ordinary Organization");
    const superAdmin = await superAdministrator();

    expect(await listPlatformOrganizationCompanies(ordinary.client)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await listPlatformOrganizationCompanies(superAdmin.client)).toEqual(expect.objectContaining({
      ok: true,
      value: expect.arrayContaining([{
        id: target.organizationId,
        name: "Accounting Office",
        blocked: false,
        companies: [{ id: target.companyId, name: "Novák s.r.o.", ico: expect.any(String) }],
      }]),
    }));
  });

  it("blocks login and processing until a SuperAdmin unblocks the Organization, with an audit trail", async () => {
    const target = await administratorWithCompany("Blocked Organization");
    const worker = testWorker();
    await enableAiProcessing(target.client, worker.jobs, {
      companyId: target.companyId,
      provider: worker.ai,
    });
    const uploaded = await uploadSourceFile(target.client, worker.jobs, {
      companyId: target.companyId,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    const ordinary = await signedUpUser("Ordinary Organization");
    const superAdmin = await superAdministrator();

    expect(await setPlatformOrganizationBlocked(ordinary.client, {
      organizationId: target.organizationId,
      blocked: true,
    })).toEqual({ ok: false, error: "forbidden" });
    expect(await setPlatformOrganizationBlocked(superAdmin.client, {
      organizationId: target.organizationId,
      blocked: true,
    })).toEqual({ ok: true, value: null });
    expect(await logIn(anonymousClient(), {
      email: target.email,
      password: "correct-horse-battery",
    })).toEqual({ ok: false, error: "organization_blocked" });

    expect(await worker.runJobs()).toEqual([]);
    expect(await systemClient().from("source_file").select("status").eq("id", uploaded.value.id).single())
      .toEqual(expect.objectContaining({ data: { status: "uploaded" } }));

    expect(await setPlatformOrganizationBlocked(superAdmin.client, {
      organizationId: target.organizationId,
      blocked: false,
    })).toEqual({ ok: true, value: null });
    worker.releaseDelayedJobs();
    expect(await worker.runJobs()).toEqual([]);
    expect(await listSourceFiles(target.client, target.companyId)).toContainEqual(expect.objectContaining({
      id: uploaded.value.id,
      status: "split",
    }));
    expect(await logIn(anonymousClient(), {
      email: target.email,
      password: "correct-horse-battery",
    })).toEqual({ ok: true, value: null });
    expect((await listAuditEvents(target.client, target.organizationId)).filter((event) => (
      event.action === "organization.platform_block_changed"
    ))).toEqual([
      expect.objectContaining({ targetId: target.organizationId, payload: { blocked: true } }),
      expect.objectContaining({ targetId: target.organizationId, payload: { blocked: false } }),
    ]);
  });

  it("defers an Extract job while blocked and completes it after unblocking", async () => {
    const target = await administratorWithCompany("Blocked Extraction Organization");
    const superAdmin = await superAdministrator();
    const worker = testWorker();
    await enableAiProcessing(target.client, worker.jobs, {
      companyId: target.companyId,
      provider: worker.ai,
    });
    const uploaded = await uploadSourceFile(target.client, worker.jobs, {
      companyId: target.companyId,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await worker.runNextJob();
    const [document] = await listDocuments(target.client, target.companyId, uploaded.value.id);
    expect(document.status).toBe("uploaded");
    expect(await setPlatformOrganizationBlocked(superAdmin.client, {
      organizationId: target.organizationId,
      blocked: true,
    })).toEqual({ ok: true, value: null });

    expect(await worker.runJobs()).toEqual([]);
    expect(worker.delayed).toEqual([{ name: "extract-document", data: { documentId: document.id } }]);

    expect(await setPlatformOrganizationBlocked(superAdmin.client, {
      organizationId: target.organizationId,
      blocked: false,
    })).toEqual({ ok: true, value: null });
    expect((await listDocuments(target.client, target.companyId, uploaded.value.id))[0].status).toBe("uploaded");
    worker.releaseDelayedJobs();
    expect(await worker.runJobs()).toEqual([]);
    expect((await listDocuments(target.client, target.companyId, uploaded.value.id))[0].status).toBe("needs_review");
  });

  it("lets only a SuperAdmin edit upload limits and applies them to uploads", async () => {
    const target = await administratorWithCompany("Limited Organization");
    const ordinary = await signedUpUser("Ordinary Organization");
    const superAdmin = await superAdministrator();
    const defaultMaxFileBytes = 20 * 1024 * 1024;
    const editedMaxFileBytes = 22 * 1024 * 1024;

    expect(await getPlatformUploadLimits(ordinary.client)).toEqual({ ok: false, error: "forbidden" });
    expect(await setPlatformUploadLimits(ordinary.client, {
      maxFileBytes: 1,
      maxFilePages: 1,
      maxBatchFiles: 1,
    })).toEqual({ ok: false, error: "forbidden" });
    expect(await setPlatformUploadLimits(superAdmin.client, {
      maxFileBytes: editedMaxFileBytes,
      maxFilePages: 51,
      maxBatchFiles: 101,
    })).toEqual({ ok: true, value: null });
    expect(await getPlatformUploadLimits(superAdmin.client)).toEqual({
      ok: true,
      value: {
        maxFileBytes: editedMaxFileBytes,
        maxFilePages: 51,
        maxBatchFiles: 101,
      },
    });
    const acceptedAboveFormerTransportCeiling = new Uint8Array(21 * 1024 * 1024 + 1);
    acceptedAboveFormerTransportCeiling.set(fixtureFile("receipt.png"));
    expect(await uploadSourceFile(target.client, testWorker().jobs, {
      companyId: target.companyId,
      fileName: "large-receipt.png",
      bytes: acceptedAboveFormerTransportCeiling,
    })).toEqual({ ok: true, value: { id: expect.any(String) } });
    expect(await setPlatformUploadLimits(superAdmin.client, {
      maxFileBytes: 50 * 1024 * 1024 + 1,
      maxFilePages: 51,
      maxBatchFiles: 101,
    })).toEqual({ ok: false, error: "invalid_upload_limits" });
    expect(await setPlatformUploadLimits(superAdmin.client, {
      maxFileBytes: defaultMaxFileBytes,
      maxFilePages: 50,
      maxBatchFiles: 100,
    })).toEqual({ ok: true, value: null });

    const oversized = new Uint8Array(defaultMaxFileBytes + 1);
    oversized.set(fixtureFile("receipt.png"));

    expect(await uploadSourceFile(target.client, testWorker().jobs, {
      companyId: target.companyId,
      fileName: "receipt.png",
      bytes: oversized,
    })).toEqual({ ok: false, error: "file_too_large" });
    expect(await beginUploadBatch(target.client, {
      companyId: target.companyId,
      fileCount: 101,
    })).toEqual({ ok: false, error: "too_many_files" });
  });

  it("lists a terminal pg-boss failure and retries its stuck processing target once", async () => {
    const target = await administratorWithCompany("Failed Jobs Organization");
    const superAdmin = await superAdministrator();
    await setPlatformUploadLimits(superAdmin.client, {
      maxFileBytes: 20 * 1024 * 1024,
      maxFilePages: 50,
      maxBatchFiles: 100,
    });
    const splitStuck = testWorker(fakeAiProvider({
      split: () => { throw new Error("split provider timed out"); },
    }));
    await enableAiProcessing(target.client, splitStuck.jobs, {
      companyId: target.companyId,
      provider: splitStuck.ai,
    });
    const uploaded = await uploadSourceFile(target.client, splitStuck.jobs, {
      companyId: target.companyId,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    expect(await splitStuck.runJobs({ final: false })).toHaveLength(1);
    expect(await listSourceFiles(target.client, target.companyId)).toContainEqual(expect.objectContaining({
      id: uploaded.value.id,
      status: "processing",
    }));

    const extractStuck = testWorker(fakeAiProvider({
      extract: () => { throw new Error("extract provider timed out"); },
    }));
    const documentFile = await uploadSourceFile(target.client, extractStuck.jobs, {
      companyId: target.companyId,
      fileName: "document.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!documentFile.ok) throw new Error(documentFile.error);
    await extractStuck.runNextJob({ final: false });
    const [document] = await listDocuments(target.client, target.companyId, documentFile.value.id);
    expect(await extractStuck.runJobs({ final: false })).toHaveLength(1);
    expect((await listDocuments(target.client, target.companyId, documentFile.value.id))[0].status)
      .toBe("processing");
    const ordinary = await signedUpUser("Ordinary Organization");
    process.loadEnvFile(".env.local");
    const boss = createBoss({ supervise: false });
    await boss.start();
    await createProcessingQueues(boss);
    try {
      for (const name of ["split-source-file", "extract-document"] as const) {
        await boss.deleteAllJobs(name);
      }
      const jobId = await boss.send(
        "split-source-file",
        { sourceFileId: uploaded.value.id },
        { retryLimit: 0 },
      );
      if (!jobId) throw new Error("Failed to enqueue the fixture job");
      const [claimed] = await boss.fetch("split-source-file", { includeMetadata: true });
      await boss.fail("split-source-file", claimed, { message: "worker expired on its final attempt" });
      const documentJobId = await boss.send(
        "extract-document",
        { documentId: document.id },
        { retryLimit: 0 },
      );
      if (!documentJobId) throw new Error("Failed to enqueue the Document fixture job");
      const [claimedDocument] = await boss.fetch("extract-document", { includeMetadata: true });
      await boss.fail("extract-document", claimedDocument, { message: "worker crashed" });
      expect(await listFailedProcessingJobs(ordinary.client)).toEqual({
        ok: false,
        error: "forbidden",
      });
      expect(await listFailedProcessingJobs(superAdmin.client)).toEqual(expect.objectContaining({
        ok: true,
        value: expect.arrayContaining([
          expect.objectContaining({
            id: jobId,
            name: "split-source-file",
            targetId: uploaded.value.id,
            error: "worker expired on its final attempt",
          }),
          expect.objectContaining({
            id: documentJobId,
            name: "extract-document",
            targetId: document.id,
            error: "worker crashed",
          }),
          ]),
      }));
      expect(await retryFailedProcessingJob(ordinary.client, jobId)).toEqual({
        ok: false,
        error: "forbidden",
      });
      expect(await boss.getJobById("split-source-file", jobId)).toEqual(expect.objectContaining({
        state: "failed",
      }));
      expect((await Promise.all([
        retryFailedProcessingJob(superAdmin.client, jobId),
        retryFailedProcessingJob(superAdmin.client, jobId),
      ])).sort((a, b) => Number(a.ok) - Number(b.ok))).toEqual([
        { ok: false, error: "not_retryable" },
        { ok: true, value: null },
      ]);
      expect(await listSourceFiles(target.client, target.companyId)).toContainEqual(expect.objectContaining({
        id: uploaded.value.id,
        status: "uploaded",
      }));
      expect(await boss.getJobById("split-source-file", jobId)).toEqual(expect.objectContaining({
        state: "retry",
      }));
      expect(await retryFailedProcessingJob(superAdmin.client, documentJobId)).toEqual({
        ok: true,
        value: null,
      });
      expect((await listDocuments(target.client, target.companyId, documentFile.value.id))[0].status)
        .toBe("uploaded");
      expect(await boss.getJobById("extract-document", documentJobId)).toEqual(expect.objectContaining({
        state: "retry",
      }));

      const settledWorker = testWorker();
      const settledFile = await uploadSourceFile(target.client, settledWorker.jobs, {
        companyId: target.companyId,
        fileName: "already-split.png",
        bytes: fixtureFile("receipt.png"),
      });
      if (!settledFile.ok) throw new Error(settledFile.error);
      expect(await settledWorker.runJobs()).toEqual([]);
      await boss.deleteAllJobs("split-source-file");
      const nonRetryableJobId = await boss.send(
        "split-source-file",
        { sourceFileId: settledFile.value.id },
        { retryLimit: 0 },
      );
      if (!nonRetryableJobId) throw new Error("Failed to enqueue the settled fixture job");
      const [claimedSettled] = await boss.fetch("split-source-file", { includeMetadata: true });
      await boss.fail("split-source-file", claimedSettled, { message: "late worker failure" });

      expect(await retryFailedProcessingJob(superAdmin.client, nonRetryableJobId)).toEqual({
        ok: false,
        error: "not_retryable",
      });
      expect(await listSourceFiles(target.client, target.companyId)).toContainEqual(expect.objectContaining({
        id: settledFile.value.id,
        status: "split",
      }));
      expect(await boss.getJobById("split-source-file", nonRetryableJobId)).toEqual(expect.objectContaining({
        state: "failed",
      }));
    } finally {
      await boss.stop();
    }
  });
});
