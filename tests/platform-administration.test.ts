import { withPostgrestRowLimit } from "./support/postgrest";
import { Client as DatabaseClient } from "pg";
import { pragueDate } from "@/application/reporting-periods";
import { setCurrentReportingYear } from "@/application/companies";
import { generateVatReport } from "@/application/vat-reports";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { inject, describe, expect, it } from "vitest";
import { runJob, splitJob } from "@/application/processing";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { fakeExchangeRates } from "@/cnb/fake";
import { fakeAiProvider } from "@/ai/fake";
import { asUserClient } from "@/application/client";
import { logIn } from "@/application/auth";
import { listAuditEvents } from "@/application/audit";
import { exportCompanyData, getCompanyDataExportStatus } from "@/application/company-deletion";
import { listDocuments, listExtractionVersions, getDocument, reprocessDocument, startManualDocumentReview } from "@/application/documents";
import {
  listPlatformOrganizationCompanies,
  getPlatformUploadLimits,
  setPlatformUploadLimits,
  setPlatformOrganizationBlocked,
} from "@/application/platform-administration";
import {
  listFailedProcessingJobs,
  takeOverFailedProcessingJob,
  retryFailedProcessingJob,
} from "@/application/processing-administration";
import { listPlatformOperationalProblems } from "@/application/operational-problems";
import { listSourceFiles, uploadSourceFile, retrySplit } from "@/application/source-files";
import { beginUploadBatch } from "@/application/upload-batches";
import {
  createBoss,
  createProcessingQueues,
  pgBossJobQueue,
} from "@/lib/jobs";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
} from "./support/fixtures";
import { anonymousClient, provisionedUser } from "./support/clients";
import { fixtureFile, selectUploadFiles } from "./support/files";
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
  const user = await provisionedUser("Platform Administration");
  const { error } = await systemClient().from("platform_user").insert({
    user_id: user.userId,
    role: "super_admin",
  });
  if (error) throw error;
  return { ...user, client: aal2Client(user.userId) };
}

describe("SuperAdmin organization console", () => {
  it("isolates the live operational dashboard to SuperAdmin", async () => {
    const ordinary = await provisionedUser("Ordinary operational viewer");
    const superAdmin = await superAdministrator();

    expect(await listPlatformOperationalProblems(ordinary.client)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await listPlatformOperationalProblems(superAdmin.client)).toEqual({
      ok: true,
      value: expect.any(Array),
    });
  });

  it("lists every Organization and Company only for a SuperAdmin", async () => {
    const target = await administratorWithCompany("Accounting Office");
    const ordinary = await provisionedUser("Ordinary Organization");
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

  it("lists Organizations beyond the PostgREST row limit", async () => {
    const superAdmin = await superAdministrator();
    const inserted = await systemClient().from("organization").insert(
      Array.from({ length: 21 }, (_, index) => ({
        name: `Platform inventory ${index.toString().padStart(4, "0")}`,
      })),
    ).select("id");
    if (inserted.error) throw inserted.error;

    const insertedIds = new Set(inserted.data.map((organization) => organization.id));
    try {
      await withPostgrestRowLimit(20,
        () => systemClient().from("organization").select("id").in("id", [...insertedIds]),
        async () => {
          const result = await listPlatformOrganizationCompanies(superAdmin.client);
          expect(result).toEqual({ ok: true, value: expect.any(Array) });
          if (!result.ok) throw new Error(result.error);
          expect(result.value.filter((organization) => insertedIds.has(organization.id))).toHaveLength(21);
        },
      );
    } finally {
      const deleted = await systemClient().from("organization").delete().in("id", [...insertedIds]);
      if (deleted.error) throw deleted.error;
    }
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
    const ordinary = await provisionedUser("Ordinary Organization");
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

    expect(await setPlatformOrganizationBlocked(superAdmin.client, {
      organizationId: target.organizationId,
      blocked: false,
    })).toEqual({ ok: true, value: null });
    expect(await listSourceFiles(target.client, target.companyId)).toContainEqual(expect.objectContaining({
      id: uploaded.value.id,
      status: "uploaded",
    }));
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
    const ordinary = await provisionedUser("Ordinary Organization");
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
      selectedFiles: selectUploadFiles(Array.from({ length: 101 }, (_, index) => ({ fileName: `${index}.png`, bytes: new Uint8Array([...fixtureFile("receipt.png"), index]) }))).selectedFiles,
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
    const uploadedBytes = fixtureFile("receipt.png");
    const uploaded = await uploadSourceFile(target.client, splitStuck.jobs, {
      companyId: target.companyId,
      fileName: "receipt.png",
      bytes: uploadedBytes,
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
    expect(await extractStuck.runJobs({ final: true })).toEqual([
      expect.objectContaining({ message: "extract provider timed out" }),
    ]);
    expect((await listDocuments(target.client, target.companyId, documentFile.value.id))[0].status)
      .toBe("failed");
    const ordinary = await provisionedUser("Ordinary Organization");
    process.loadEnvFile(".env.local");
    const boss = createBoss({ supervise: false });
    await boss.start();
    await createProcessingQueues(boss);
    try {
      for (const name of ["split-source-file", "extract-document", "complete-company-export"] as const) {
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
      const exportTarget = await administratorWithCompany("Failed Export Organization");
      const exportUploaded = await uploadSourceFile(exportTarget.client, { async send() {} }, {
        companyId: exportTarget.companyId,
        fileName: "receipt.png",
        bytes: uploadedBytes,
      });
      if (!exportUploaded.ok) throw new Error(exportUploaded.error);
      const exportWorker = testWorker();
      const exported = await exportCompanyData(exportTarget.client, exportWorker.jobs, {
        companyId: exportTarget.companyId,
      });
      if (!exported.ok) throw new Error(exported.error);
      const [completionJob] = exportWorker.queued;
      const originalPath = `${exportTarget.companyId}/${exportUploaded.value.id}`;
      expect((await systemClient().storage.from("source-files").remove([originalPath])).error).toBeNull();
      expect(await exportWorker.runJobs({ final: true })).toHaveLength(1);
      expect(await getCompanyDataExportStatus(exportTarget.client, {
        companyId: exportTarget.companyId,
        exportId: exported.value.exportId,
      })).toEqual({ ok: true, value: "failed" });
      const exportJobId = await boss.send(
        "complete-company-export",
        { exportId: exported.value.exportId },
        { retryLimit: 0 },
      );
      if (!exportJobId) throw new Error("Failed to enqueue the export fixture job");
      const [claimedExport] = await boss.fetch("complete-company-export", { includeMetadata: true });
      await boss.fail("complete-company-export", claimedExport, { message: "storage was unavailable" });
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
          expect.objectContaining({
            id: exportJobId,
            name: "complete-company-export",
            targetId: exported.value.exportId,
            error: "storage was unavailable",
          }),
          ]),
      }));
      expect(await listPlatformOperationalProblems(superAdmin.client)).toEqual(expect.objectContaining({
        ok: true,
        value: expect.arrayContaining([
          expect.objectContaining({
            kind: "terminal_processing_job",
            affectedDocumentCount: 1,
            companies: expect.arrayContaining([
              expect.objectContaining({ id: target.companyId, affectedDocumentCount: 1 }),
            ]),
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
      const afterDocumentRetry = await listPlatformOperationalProblems(superAdmin.client);
      if (!afterDocumentRetry.ok) throw new Error(afterDocumentRetry.error);
      expect(afterDocumentRetry.value.some((problem) => (
        problem.kind === "terminal_processing_job" && problem.targetIds.includes(document.id)
      ))).toBe(false);
      expect((await listDocuments(target.client, target.companyId, documentFile.value.id))[0].status)
        .toBe("uploaded");
      expect(await boss.getJobById("extract-document", documentJobId)).toEqual(expect.objectContaining({
        state: "retry",
      }));
      expect((await Promise.all([
        retryFailedProcessingJob(superAdmin.client, exportJobId),
        retryFailedProcessingJob(superAdmin.client, exportJobId),
      ])).sort((a, b) => Number(a.ok) - Number(b.ok))).toEqual([
        { ok: false, error: "not_retryable" },
        { ok: true, value: null },
      ]);
      expect(await getCompanyDataExportStatus(exportTarget.client, {
        companyId: exportTarget.companyId,
        exportId: exported.value.exportId,
      })).toEqual({ ok: true, value: "pending" });
      expect(await boss.getJobById("complete-company-export", exportJobId)).toEqual(expect.objectContaining({
        state: "retry",
      }));
      expect((await systemClient().storage.from("source-files").upload(originalPath, uploadedBytes, {
        contentType: "image/png",
        upsert: true,
      })).error).toBeNull();
      exportWorker.queued.push(completionJob);
      expect(await exportWorker.runJobs()).toEqual([]);
      expect(await getCompanyDataExportStatus(exportTarget.client, {
        companyId: exportTarget.companyId,
        exportId: exported.value.exportId,
      })).toEqual({ ok: true, value: "completed" });

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
      const active = await listFailedProcessingJobs(superAdmin.client);
      if (!active.ok) throw new Error(active.error);
      expect(active.value.map((job) => job.id)).not.toContain(nonRetryableJobId);
      const activeProblems = await listPlatformOperationalProblems(superAdmin.client);
      if (!activeProblems.ok) throw new Error(activeProblems.error);
      expect(activeProblems.value.flatMap((problem) => problem.targetIds)).not.toContain(settledFile.value.id);
    } finally {
      await boss.stop();
    }
  });
});


it("manual Platform takeover resolves a current Split failure before Document definition and preserves queue history", async () => {
  const company = await administratorWithCompany("Manual Platform recovery");
  const operator = await superAdministrator();
  const worker = testWorker(fakeAiProvider({ split: () => { throw new Error("terminal split"); } }));
  await enableAiProcessing(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  const source = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId, fileName: "manual.png", bytes: fixtureFile("receipt.png"),
  });
  if (!source.ok) throw new Error(source.error);
  expect(await worker.runJobs()).toHaveLength(1);
  process.loadEnvFile(".env.local");
  const boss = createBoss({ supervise: false });
  await boss.start(); await createProcessingQueues(boss);
  try {
    const id = await boss.send("split-source-file", { sourceFileId: source.value.id }, { retryLimit: 0 });
    if (!id) throw new Error("fixture enqueue refused");
    for (let index = 0; index < 20; index++) {
      await boss.send("split-source-file", { sourceFileId: source.value.id }, { retryLimit: 0 });
    }
    const claimed = await boss.fetch("split-source-file", { includeMetadata: true, batchSize: 100 });
    await boss.fail("split-source-file", claimed.map((job) => job.id), { message: "terminal split" });
    await withPostgrestRowLimit(20, () => operator.client.rpc("list_failed_processing_jobs"), async () => {
      const complete = await listFailedProcessingJobs(operator.client);
      if (!complete.ok) throw new Error(complete.error);
      expect(complete.value.filter((job) => job.targetId === source.value.id)).toHaveLength(21);
    });
    expect(await takeOverFailedProcessingJob(company.client, id)).toEqual({ ok: false, error: "forbidden" });
    const active = await listFailedProcessingJobs(operator.client);
    if (!active.ok) throw new Error(active.error);
    expect(active.value.map((job) => job.id)).toContain(id);
    expect(await takeOverFailedProcessingJob(operator.client, id)).toEqual({ ok: true, value: null });
    expect(await listSourceFiles(company.client, company.companyId)).toContainEqual(expect.objectContaining({ id: source.value.id, status: "needs_review" }));
    expect(await listDocuments(company.client, company.companyId, source.value.id)).toEqual([]);
    const resolved = await listFailedProcessingJobs(operator.client);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.value.map((job) => job.id)).not.toContain(id);
    const problems = await listPlatformOperationalProblems(operator.client);
    if (!problems.ok) throw new Error(problems.error);
    expect(problems.value.flatMap((problem) => problem.targetIds)).not.toContain(source.value.id);
    expect(await boss.getJobById("split-source-file", id)).toMatchObject({ state: "failed" });
    expect(await retryFailedProcessingJob(operator.client, id)).toEqual({ ok: false, error: "not_retryable" });
    const audit = await listAuditEvents(operator.client, company.organizationId);
    expect(audit).toContainEqual(expect.objectContaining({ action: "source_file.manual_review_started", actorUserId: operator.userId }));
    // Claim before the generation changes; the handler reads the newer request.
    const laterId = await boss.send("split-source-file", { sourceFileId: source.value.id }, { retryLimit: 0 });
    if (!laterId) throw new Error("later enqueue refused");
    const [later] = await boss.fetch("split-source-file", { includeMetadata: true });
    expect(await retrySplit(company.client, worker.jobs, { companyId: company.companyId, sourceFileId: source.value.id })).toEqual({ ok: true, value: null });
    await boss.fail("split-source-file", later, { message: "queue expired before the handler read its request" });
    await expect(worker.runNextJob({ final: true, queueJobId: laterId })).rejects.toThrow("terminal split");
    const renewed = await listFailedProcessingJobs(operator.client);
    if (!renewed.ok) throw new Error(renewed.error);
    expect(renewed.value.filter((job) => job.targetId === source.value.id).map((job) => job.id)).toEqual([laterId]);
    // A stale worker cannot replace this attempt's generation binding.
    expect((await systemClient().rpc("bind_processing_job_request", {
      target_job_id: laterId, target_request_id: crypto.randomUUID(), target_retry_count: 1,
    })).error).toBeNull();
    const afterStaleBinding = await listFailedProcessingJobs(operator.client);
    if (!afterStaleBinding.ok) throw new Error(afterStaleBinding.error);
    expect(afterStaleBinding.value.filter((job) => job.targetId === source.value.id).map((job) => job.id)).toEqual([laterId]);
    expect((await company.client.rpc("bind_processing_job_request", {
      target_job_id: laterId, target_request_id: crypto.randomUUID(), target_retry_count: 0,
    })).error?.code).toBe("42501");
    expect(await retryFailedProcessingJob(operator.client, id)).toEqual({ ok: false, error: "not_retryable" });

  } finally { await boss.stop(); }
});

it("a legacy Split failure stays active when a locked Source refuses Platform takeover", async () => {
  const company = await administratorWithCompany("Locked Platform recovery");
  const operator = await superAdministrator();
  const source = await uploadSourceFile(company.client, { async send() {} }, {
    companyId: company.companyId, fileName: "locked.png", bytes: fixtureFile("receipt.png"),
  });
  if (!source.ok) throw new Error(source.error);
  const [file] = await listSourceFiles(company.client, company.companyId);
  const period = pragueDate(file.uploadedAt).slice(0, 7);
  await setCurrentReportingYear(company.client, { companyId: company.companyId, year: Number(period.slice(0, 4)), filingFrequency: "monthly" });
  expect((await generateVatReport(company.client, { companyId: company.companyId, period })).ok).toBe(true);
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  process.loadEnvFile(".env.local");
  const boss = createBoss({ supervise: false });
  await boss.start(); await createProcessingQueues(boss);
  try {
    // Unknown pre-migration generation boundary and a historical failed attempt.
    await database.query("update public.source_file set split_requested_at = null where id = $1", [source.value.id]);
    const inserted = await database.query<{ id: string }>(`insert into pgboss.job (name, data, state, started_on, completed_on)
      values ('split-source-file', jsonb_build_object('sourceFileId', $1::uuid), 'failed', '2000-01-01', '2000-01-01') returning id`, [source.value.id]);
    const id = inserted.rows[0].id;
    // A retained report snapshot can protect Source recovery irrespective of its status.
    await database.query(`insert into public.period_lock (company_id, organization_id, period, vat_report_id, locked_by)
      select company_id, organization_id, period, id, $3 from public.vat_report where company_id = $1 and period = $2`, [company.companyId, period, company.userId]);
    const before = await listFailedProcessingJobs(operator.client);
    if (!before.ok) throw new Error(before.error);
    expect(before.value.map((job) => job.id)).toContain(id);
    expect(await takeOverFailedProcessingJob(operator.client, id)).toEqual({ ok: false, error: "period_locked" });
    expect(await retryFailedProcessingJob(operator.client, id)).toEqual({ ok: false, error: "period_locked" });
    expect((await operator.client.rpc("take_over_failed_processing_job", { target_failed_job_id: id })).error?.hint).toBe("period_locked");
    const after = await listFailedProcessingJobs(operator.client);
    if (!after.ok) throw new Error(after.error);
    expect(after.value.map((job) => job.id)).toContain(id);
    const problems = await listPlatformOperationalProblems(operator.client);
    if (!problems.ok) throw new Error(problems.error);
    expect(problems.value).toContainEqual(expect.objectContaining({ kind: "terminal_processing_job", targetIds: [source.value.id], affectedDocumentCount: 1 }));
    expect(await listSourceFiles(company.client, company.companyId)).toContainEqual(expect.objectContaining({ id: source.value.id, status: "uploaded" }));
    expect(await boss.getJobById("split-source-file", id)).toMatchObject({ state: "failed" });
    const audit = await listAuditEvents(operator.client, company.organizationId);
    expect(audit.some((event) => event.action === "source_file.manual_review_started")).toBe(false);
  } finally { await database.end(); await boss.stop(); }
});

it("Platform takeover of a failed Split with Documents continues their manual review without splitting again", async () => {
  const company = await administratorWithCompany("Existing Documents recovery");
  const operator = await superAdministrator();
  const worker = testWorker(fakeAiProvider({ extract: () => { throw new Error("terminal extraction"); } }));
  await enableAiProcessing(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  const source = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId, fileName: "documents.png", bytes: fixtureFile("receipt.png"),
  });
  if (!source.ok) throw new Error(source.error);
  expect(await worker.runJobs()).toHaveLength(1);
  const [document] = await listDocuments(company.client, company.companyId, source.value.id);
  const failed = await systemClient().from("source_file").update({ status: "failed" }).eq("id", source.value.id);
  if (failed.error) throw failed.error;
  process.loadEnvFile(".env.local");
  const boss = createBoss({ supervise: false }); await boss.start(); await createProcessingQueues(boss);
  try {
    const splitId = await boss.send("split-source-file", { sourceFileId: source.value.id }, { retryLimit: 0 });
    const extractionId = await boss.send("extract-document", { documentId: document.id }, { retryLimit: 0 });
    if (!splitId || !extractionId) throw new Error("fixture enqueue refused");
    for (const name of ["split-source-file", "extract-document"] as const) {
      const claimed = await boss.fetch(name, { includeMetadata: true, batchSize: 100 });
      await boss.fail(name, claimed.map((job) => job.id), { message: "legacy partial processing failure" });
    }
    const aal1 = anonymousClient();
    await aal1.auth.signInWithPassword({ email: operator.email, password: "correct-horse-battery" });
    expect(await takeOverFailedProcessingJob(aal1, splitId)).toEqual({ ok: false, error: "forbidden" });
    expect((await company.client.rpc("take_over_failed_processing_job", { target_failed_job_id: extractionId })).error?.code).toBe("42501");
    expect(await takeOverFailedProcessingJob(operator.client, splitId)).toEqual({ ok: true, value: null });
    expect(await listDocuments(company.client, company.companyId, source.value.id)).toEqual([
      expect.objectContaining({ id: document.id, status: "needs_review" }),
    ]);
    expect(await listExtractionVersions(company.client, company.companyId, document.id)).toEqual([]);
    expect(await listSourceFiles(company.client, company.companyId)).toContainEqual(expect.objectContaining({ id: source.value.id, status: "split" }));
    const active = await listFailedProcessingJobs(operator.client);
    if (!active.ok) throw new Error(active.error);
    expect(active.value.map((job) => job.id)).not.toContain(splitId);
    expect(active.value.map((job) => job.id)).not.toContain(extractionId);
    expect(await boss.getJobById("split-source-file", splitId)).toMatchObject({ state: "failed" });
    expect(await boss.getJobById("extract-document", extractionId)).toMatchObject({ state: "failed" });
    const audit = await listAuditEvents(operator.client, company.organizationId);
    expect(audit).toContainEqual(expect.objectContaining({ action: "document.manual_review_started", actorUserId: operator.userId, targetId: document.id }));
  } finally { await boss.stop(); }
});

it("Extraction takeover invalidates a late worker and serializes with retry without concealing a later failure", async () => {
  const company = await administratorWithCompany("Extraction takeover races");
  const operator = await superAdministrator();
  let started!: () => void;
  const inFlight = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const worker = testWorker(fakeAiProvider({ extract: async () => {
    calls++;
    if (calls === 1) { started(); await hold; }
    throw new Error("extraction attempt failed");
  } }));
  await enableAiProcessing(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  const source = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId, fileName: "late-extraction.png", bytes: fixtureFile("receipt.png"),
  });
  if (!source.ok) throw new Error(source.error);
  await worker.runNextJob();
  const [document] = await listDocuments(company.client, company.companyId, source.value.id);
  process.loadEnvFile(".env.local");
  const boss = createBoss({ supervise: false }); await boss.start(); await createProcessingQueues(boss);
  let oldAttempt: Promise<void> | undefined;
  try {
    await boss.deleteAllJobs("extract-document");
    const oldId = await boss.send("extract-document", { documentId: document.id }, { retryLimit: 0 });
    if (!oldId) throw new Error("fixture enqueue refused");
    const [oldJob] = await boss.fetch("extract-document", { includeMetadata: true });
    oldAttempt = worker.runNextJob({ final: true, queueJobId: oldId });
    const oldOutcome = oldAttempt.catch((error: unknown) => error);
    await inFlight;
    // Simulate queue expiry while the provider call is still in flight.
    await boss.fail("extract-document", oldJob, { message: "expired worker" });
    expect(await takeOverFailedProcessingJob(operator.client, oldId)).toEqual({ ok: true, value: null });
    expect((await getDocument(company.client, company.companyId, document.id))?.status).toBe("needs_review");
    expect(await listExtractionVersions(company.client, company.companyId, document.id)).toEqual([]);
    const input = { companyId: company.companyId, documentId: document.id, confirmed: true };
    expect(await reprocessDocument(company.client, worker.jobs, input)).toEqual({ ok: true, value: null });
    const newId = await boss.send("extract-document", { documentId: document.id }, { retryLimit: 0 });
    if (!newId) throw new Error("later enqueue refused");
    const [newJob] = await boss.fetch("extract-document", { includeMetadata: true });
    await expect(worker.runNextJob({ final: true, queueJobId: newId })).rejects.toThrow("extraction attempt failed");
    await boss.fail("extract-document", newJob, { message: "current extraction failure" });
    release();
    expect(await oldOutcome).toBeInstanceOf(Error);
    expect((await getDocument(company.client, company.companyId, document.id))?.status).toBe("failed");
    const active = await listFailedProcessingJobs(operator.client);
    if (!active.ok) throw new Error(active.error);
    expect(active.value.filter((job) => job.targetId === document.id).map((job) => job.id)).toEqual([newId]);
    const race = await Promise.all([
      takeOverFailedProcessingJob(operator.client, newId),
      retryFailedProcessingJob(operator.client, newId),
    ]);
    expect(race.filter((result) => result.ok)).toHaveLength(1);
    if (race[0].ok) {
      expect(race[1]).toEqual({ ok: false, error: "not_retryable" });
      expect((await getDocument(company.client, company.companyId, document.id))?.status).toBe("needs_review");
    } else {
      expect(race[0]).toEqual({ ok: false, error: "not_recoverable" });
      expect((await getDocument(company.client, company.companyId, document.id))?.status).toBe("uploaded");
    }
  } finally {
    release();
    await oldAttempt?.catch(() => undefined);
    await boss.stop();
  }
});

it.each([
  ["split-source-file", "manual"], ["extract-document", "manual"],
  ["split-source-file", "retry"], ["extract-document", "retry"],
] as const)("a current %s queue failure before its first status change remains actionable for %s recovery", async (name, recovery) => {
  const company = await administratorWithCompany("Pre-status queue expiry");
  const operator = await superAdministrator();
  const worker = testWorker();
  await enableAiProcessing(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  const source = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId, fileName: "expired-before-start.png", bytes: fixtureFile("receipt.png"),
  });
  if (!source.ok) throw new Error(source.error);
  if (name === "extract-document") await worker.runNextJob();
  const [document] = await listDocuments(company.client, company.companyId, source.value.id);
  const targetId = name === "split-source-file" ? source.value.id : document.id;
  process.loadEnvFile(".env.local");
  const boss = createBoss({ supervise: false }); await boss.start(); await createProcessingQueues(boss);
  try {
    await boss.deleteAllJobs(name);
    const id = await boss.send(name, name === "split-source-file" ? { sourceFileId: targetId } : { documentId: targetId }, { retryLimit: 0 });
    if (!id) throw new Error("fixture enqueue refused");
    const [claimed] = await boss.fetch(name, { includeMetadata: true });
    // Queue expiry/process death before the handler performs any target write.
    await boss.fail(name, claimed, { message: "worker expired before its first CAS" });
    const active = await listFailedProcessingJobs(operator.client);
    if (!active.ok) throw new Error(active.error);
    expect(active.value.map((job) => job.id)).toContain(id);
    const problems = await listPlatformOperationalProblems(operator.client);
    if (!problems.ok) throw new Error(problems.error);
    expect(problems.value).toContainEqual(expect.objectContaining({ kind: "terminal_processing_job", targetIds: [targetId], affectedDocumentCount: 1 }));
    if (recovery === "manual") {
      expect(await takeOverFailedProcessingJob(operator.client, id)).toEqual({ ok: true, value: null });
      if (name === "split-source-file") {
        expect(await listSourceFiles(company.client, company.companyId)).toContainEqual(expect.objectContaining({ id: targetId, status: "needs_review" }));
      } else {
        expect((await getDocument(company.client, company.companyId, targetId))?.status).toBe("needs_review");
      }
      expect(await boss.getJobById(name, id)).toMatchObject({ state: "failed" });
    } else {
      expect(await retryFailedProcessingJob(operator.client, id)).toEqual({ ok: true, value: null });
      const [retry] = await boss.fetch(name, { includeMetadata: true });
      await worker.runNextJob({ queueJobId: id, queueRetryCount: retry.retryCount });
      expect(await worker.runJobs()).toEqual([]);
      await boss.complete(name, retry);
      expect(await listDocuments(company.client, company.companyId, source.value.id)).toEqual([
        expect.objectContaining({ status: "needs_review" }),
      ]);
    }
    const resolved = await listFailedProcessingJobs(operator.client);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.value.map((job) => job.id)).not.toContain(id);
  } finally { await boss.stop(); }
});

it.each(["manual", "document_manual", "retry", "later_worker"] as const)("a post-Split queue dispatch failure continues existing Documents through %s without another AI Split", async (recovery) => {
  const company = await administratorWithCompany("Split dispatch recovery");
  const operator = await superAdministrator();
  let splitCalls = 0;
  const ai = fakeAiProvider({ split: () => {
    if (++splitCalls > 1) throw new Error("the completed Split must not run again");
    return [{ firstPage: 1, lastPage: 1 }];
  } });
  await enableAiProcessing(company.client, { async send() {} }, { companyId: company.companyId, provider: ai });
  const source = await uploadSourceFile(company.client, { async send() {} }, {
    companyId: company.companyId, fileName: "split-dispatch.png", bytes: fixtureFile("receipt.png"),
  });
  if (!source.ok) throw new Error(source.error);
  process.loadEnvFile(".env.local");
  const boss = createBoss({ supervise: false }); await boss.start(); await createProcessingQueues(boss);
  const disconnectedSender = createBoss({ supervise: false }); await disconnectedSender.start();
  const worker = {
    system: systemClient(), providers: { get: () => ai },
    jobs: pgBossJobQueue(boss), vatRegistry: fakeVatPayerRegistry(), exchangeRates: fakeExchangeRates(),
  };
  try {
    await boss.deleteAllJobs("split-source-file"); await boss.deleteAllJobs("extract-document");
    const id = await boss.send("split-source-file", { sourceFileId: source.value.id }, { retryLimit: 0 });
    if (!id) throw new Error("fixture enqueue refused");
    const [claimed] = await boss.fetch("split-source-file", { includeMetadata: true });
    // The actual pg-boss sender becomes unavailable while database HTTP stays up.
    await disconnectedSender.stop();
    await expect(runJob({ ...worker, jobs: pgBossJobQueue(disconnectedSender) }, splitJob(source.value.id), {
      final: true, queueJobId: id, queueRetryCount: claimed.retryCount,
    })).rejects.toThrow();
    await boss.fail("split-source-file", claimed, { message: "Extraction dispatch connection unavailable" });
    expect(await listSourceFiles(company.client, company.companyId)).toContainEqual(expect.objectContaining({ id: source.value.id, status: "split" }));
    const [document] = await listDocuments(company.client, company.companyId, source.value.id);
    expect(document.status).toBe("uploaded");
    const active = await listFailedProcessingJobs(operator.client);
    if (!active.ok) throw new Error(active.error);
    expect(active.value.map((job) => job.id)).toContain(id);
    const problems = await listPlatformOperationalProblems(operator.client);
    if (!problems.ok) throw new Error(problems.error);
    expect(problems.value).toContainEqual(expect.objectContaining({ kind: "terminal_processing_job", targetIds: [source.value.id] }));
    if (recovery === "manual" || recovery === "document_manual") {
      expect(recovery === "manual"
        ? await takeOverFailedProcessingJob(operator.client, id)
        : await startManualDocumentReview(company.client, { companyId: company.companyId, documentId: document.id })
      ).toEqual({ ok: true, value: null });
      expect((await getDocument(company.client, company.companyId, document.id))?.status).toBe("needs_review");
      const audit = await listAuditEvents(operator.client, company.organizationId);
      expect(audit).toContainEqual(expect.objectContaining({ action: "document.manual_review_started", targetId: document.id, actorUserId: recovery === "manual" ? operator.userId : company.userId }));
      if (recovery === "document_manual") {
        expect(await reprocessDocument(company.client, { async send() {} }, { companyId: company.companyId, documentId: document.id, confirmed: true })).toEqual({ ok: true, value: null });
        expect((await getDocument(company.client, company.companyId, document.id))?.status).toBe("uploaded");
      }
    } else {
      let resumeId = id;
      if (recovery === "retry") {
        expect(await retryFailedProcessingJob(operator.client, id)).toEqual({ ok: true, value: null });
      } else {
        resumeId = (await boss.send("split-source-file", { sourceFileId: source.value.id }, { retryLimit: 0 }))!;
      }
      const [resumed] = await boss.fetch("split-source-file", { includeMetadata: true });
      await runJob(worker, splitJob(source.value.id), { final: true, queueJobId: resumeId, queueRetryCount: resumed.retryCount });
      await boss.complete("split-source-file", resumed);
      const dispatched = await listFailedProcessingJobs(operator.client);
      if (!dispatched.ok) throw new Error(dispatched.error);
      expect(dispatched.value.map((job) => job.id)).not.toContain(id);
      // Even with the Extraction still queued, successful dispatch supersedes the incident.
      expect((await getDocument(company.client, company.companyId, document.id))?.status).toBe("uploaded");
      const [extraction] = await boss.fetch("extract-document", { includeMetadata: true });
      await runJob(worker, { name: "extract-document", data: { documentId: document.id } }, {
        final: true, queueJobId: extraction.id, queueRetryCount: extraction.retryCount,
      });
      await boss.complete("extract-document", extraction);
      expect((await getDocument(company.client, company.companyId, document.id))?.status).toBe("needs_review");
    }
    expect((await listDocuments(company.client, company.companyId, source.value.id)).map((entry) => entry.id)).toEqual([document.id]);
    const resolved = await listFailedProcessingJobs(operator.client);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.value.map((job) => job.id)).not.toContain(id);
    if (recovery !== "retry") expect(await boss.getJobById("split-source-file", id)).toMatchObject({ state: "failed" });
  } finally { await disconnectedSender.stop(); await boss.stop(); }
});
