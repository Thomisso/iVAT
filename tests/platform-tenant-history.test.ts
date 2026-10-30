import { describe, expect, it } from "vitest";
import { listMyOrganizations } from "@/application/organizations";
import { getCompany } from "@/application/companies";
import { listAuditEvents } from "@/application/audit";
import { setOrganizationMfaRequired } from "@/application/mfa";
import { setPlatformOrganizationBlocked } from "@/application/platform-administration";
import { listSourceFiles, uploadSourceFile } from "@/application/source-files";
import { finalizeVatReport, generateVatReport } from "@/application/vat-reports";
import { administratorWithCompany, assignAiConfigurationFixture } from "./support/fixtures";
import { promotedSuperAdministrator } from "./support/platform";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";
import { exportCompanyData, softDeleteCompany } from "@/application/company-deletion";
import { downloadPlatformCompanyHistory, getPlatformCompanyHistory, readPlatformCompanySourceFile } from "@/application/platform-company-history";
import { strFromU8, unzipSync } from "fflate";
import { signedUpUser } from "./support/clients";
import { systemClient } from "./support/worker";

describe("SuperAdmin support for unavailable tenants", () => {
  it("reads a deleted Company's retained Documents, versions and audit without restoring access", async () => {
    const target = await administratorWithCompany("Deleted history target");
    const operator = await promotedSuperAdministrator("History operator");
    const worker = testWorker();
    await assignAiConfigurationFixture(target.client, worker.jobs, { companyId: target.companyId, provider: worker.ai });
    const uploaded = await uploadSourceFile(target.client, worker.jobs, {
      companyId: target.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    expect(await worker.runJobs()).toEqual([]);
    const exported = await exportCompanyData(operator.client, worker.jobs, { companyId: target.companyId });
    if (!exported.ok) throw new Error(exported.error);
    expect(await worker.runJobs()).toEqual([]);
    expect((await softDeleteCompany(operator.client, { companyId: target.companyId, exportId: exported.value.exportId })).ok)
      .toBe(true);

    const history = await getPlatformCompanyHistory(operator.client, target.companyId);
    expect(history).toEqual({ ok: true, value: expect.objectContaining({
      deletedAt: expect.any(String), organizationName: "Deleted history target", blocked: false,
      snapshot: expect.objectContaining({
        company: expect.objectContaining({ id: target.companyId, name: "Novák s.r.o." }),
        sourceFiles: [expect.objectContaining({ id: uploaded.value.id, fileName: "receipt.png" })],
        documents: [expect.objectContaining({
          extractionVersions: [expect.objectContaining({ version: 1, payload: expect.any(Object) })],
        })],
      }),
      auditEvents: expect.arrayContaining([expect.objectContaining({
        action: "company.deleted", actorUserId: operator.userId,
      })]),
    }) });
    expect(await getCompany(operator.client, target.companyId)).toBeNull();
    expect(await getCompany(target.client, target.companyId)).toBeNull();
    expect(await getPlatformCompanyHistory(target.client, target.companyId)).toEqual({ ok: false, error: "forbidden" });
    expect(await uploadSourceFile(operator.client, worker.jobs, {
      companyId: target.companyId, fileName: "cannot-restore.png", bytes: fixtureFile("receipt.png"),
    })).toEqual({ ok: false, error: "forbidden" });
    expect(await readPlatformCompanySourceFile(operator.client, {
      companyId: target.companyId, sourceFileId: uploaded.value.id,
    })).toEqual({ ok: true, value: {
      bytes: fixtureFile("receipt.png"), fileName: "receipt.png", mediaType: "image/png",
    } });
    const archive = await downloadPlatformCompanyHistory(operator.client, target.companyId);
    if (!archive.ok) throw new Error(archive.error);
    const entries = unzipSync(archive.value.bytes);
    expect(entries[`source-files/${uploaded.value.id}/receipt.png`]).toEqual(fixtureFile("receipt.png"));
    expect(JSON.parse(strFromU8(entries["documents.json"]))).toEqual([
      expect.objectContaining({ extractionVersions: [expect.objectContaining({ version: 1 })] }),
    ]);
    const unverified = await signedUpUser("Unverified support operator");
    const promoted = await systemClient().from("platform_user").insert({ user_id: unverified.userId, role: "super_admin" });
    if (promoted.error) throw promoted.error;
    for (const actor of [target, unverified]) {
      expect(await getPlatformCompanyHistory(actor.client, target.companyId)).toEqual({ ok: false, error: "forbidden" });
      expect(await readPlatformCompanySourceFile(actor.client, { companyId: target.companyId, sourceFileId: uploaded.value.id }))
        .toEqual({ ok: false, error: "forbidden" });
      const direct = await actor.client.rpc("platform_company_history", { target_company_id: target.companyId });
      expect(direct.error?.code).toBe("42501");
      expect((await actor.client.storage.from("source-files").download(`${target.companyId}/${uploaded.value.id}`)).error)
        .not.toBeNull();
    }
    expect((await getPlatformCompanyHistory(operator.client, target.companyId))).toEqual(history);
  });
  it("administers a blocked Organization without resuming ordinary processing until explicit unblock", async () => {
    const target = await administratorWithCompany("Blocked support target");
    const operator = await promotedSuperAdministrator("Support operator");
    const worker = testWorker();
    await assignAiConfigurationFixture(target.client, worker.jobs, { companyId: target.companyId, provider: worker.ai });
    const uploaded = await uploadSourceFile(target.client, worker.jobs, {
      companyId: target.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    expect(await setPlatformOrganizationBlocked(operator.client, { organizationId: target.organizationId, blocked: true }))
      .toEqual({ ok: true, value: null });
    expect(await listMyOrganizations(operator.client)).toContainEqual({
      id: target.organizationId, name: "Blocked support target", role: "administrator",
    });
    expect(await listMyOrganizations(target.client)).toEqual([]);
    expect(await getCompany(target.client, target.companyId)).toBeNull();
    expect(await setOrganizationMfaRequired(operator.client, { organizationId: target.organizationId, required: true }))
      .toEqual({ ok: true, value: null });
    expect(await uploadSourceFile(operator.client, worker.jobs, {
      companyId: target.companyId, fileName: "blocked.png", bytes: fixtureFile("receipt.png"),
    })).toEqual({ ok: false, error: "forbidden" });
    const period = { companyId: target.companyId, period: "2026-10" };
    expect(await generateVatReport(operator.client, period)).toEqual({ ok: false, error: "forbidden" });
    expect(await finalizeVatReport(operator.client, { ...period, confirmed: true }))
      .toEqual({ ok: false, error: "forbidden" });
    expect(await worker.runJobs()).toEqual([]);
    expect(worker.delayed).toHaveLength(1);
    expect(await setOrganizationMfaRequired(operator.client, { organizationId: target.organizationId, required: false }))
      .toEqual({ ok: true, value: null });
    expect(await setPlatformOrganizationBlocked(operator.client, { organizationId: target.organizationId, blocked: false }))
      .toEqual({ ok: true, value: null });
    expect((await listSourceFiles(target.client, target.companyId))[0].status).toBe("uploaded");
    worker.releaseDelayedJobs();
    expect(await worker.runJobs()).toEqual([]);
    expect((await listSourceFiles(target.client, target.companyId))[0].status).toBe("split");
    expect((await listAuditEvents(operator.client, target.organizationId))
      .filter((event) => event.action === "organization.platform_block_changed"))
      .toEqual([
        expect.objectContaining({ actorUserId: operator.userId, payload: { blocked: true } }),
        expect.objectContaining({ actorUserId: operator.userId, payload: { blocked: false } }),
      ]);
  });
});
