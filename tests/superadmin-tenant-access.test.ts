import { withPostgrestRowLimit } from "./support/postgrest";
import { describe, expect, it } from "vitest";
import { createCompany, getCompany, getMyCompanyRole, listMyCompanies, updateCompanyIdentity } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { listAuditEvents } from "@/application/audit";
import { listOrganizationMfaSettings, setOrganizationMfaRequired } from "@/application/mfa";
import { inviteMember, listPendingInvitations } from "@/application/memberships";
import { administratorWithCompany, assignAiConfigurationFixture, companyDetails, companyMember, platformCompanyInventoryFixture } from "./support/fixtures";
import { promotedSuperAdministrator } from "./support/platform";
import { provisionedUser } from "./support/clients";
import { systemClient, testWorker } from "./support/worker";
import { uploadSourceFile, readSourceFile } from "@/application/source-files";
import { approveDocument, listDocuments, returnDocumentToReview } from "@/application/documents";
import { finalizeVatReport, generateVatReport, getPeriodLock, unlockReportingPeriod } from "@/application/vat-reports";
import { exportCompanyData, softDeleteCompany } from "@/application/company-deletion";
import { fixtureFile } from "./support/files";

describe("membership-independent SuperAdmin authority", () => {
  it("discovers every accessible Company and Organization beyond the database response row limit", async () => {
    const operator = await promotedSuperAdministrator("Inventory operator");
    const entries = await platformCompanyInventoryFixture(21, operator.userId);
    const companyIds = new Set(entries.map((entry) => entry.companyId));
    const organizationIds = new Set(entries.map((entry) => entry.organizationId));
    try {
      await withPostgrestRowLimit(20,
        () => operator.client.from("company").select("id").in("id", [...companyIds]),
        async () => {
          expect((await listMyCompanies(operator.client)).filter((company) => companyIds.has(company.id))).toEqual(
            entries.map((entry) => ({ id: entry.companyId, organizationId: entry.organizationId, name: entry.name })),
          );
          expect((await listMyOrganizations(operator.client)).filter((organization) => organizationIds.has(organization.id)))
            .toHaveLength(21);
        },
      );
    } finally {
      const companies = await systemClient().from("company").delete().in("id", [...companyIds]);
      if (companies.error) throw companies.error;
      const deleted = await systemClient().from("organization").delete().in("id", [...organizationIds]);
      if (deleted.error) throw deleted.error;
    }
  });
  it("creates a Company and manages Organization invitations without joining the tenant", async () => {
    const target = await administratorWithCompany("Administrative target");
    const operator = await promotedSuperAdministrator("Administrative operator");
    const created = await createCompany(operator.client, {
      organizationId: target.organizationId, ...companyDetails({ name: "Created by platform operator" }),
    });
    expect(created).toEqual({ ok: true, value: { id: expect.any(String) } });
    if (!created.ok) throw new Error(created.error);
    expect(await getCompany(target.client, created.value.id)).toEqual(expect.objectContaining({
      organizationId: target.organizationId, name: "Created by platform operator",
    }));
    expect(await inviteMember(operator.client, { async sendInvitation() {} }, {
      organizationId: target.organizationId, companyId: null, role: "administrator",
      email: "invited-by-platform@example.test", acceptUrl: "http://localhost/invitations/accept",
    })).toEqual({ ok: true, value: null });
    expect(await listPendingInvitations(operator.client, { organizationId: target.organizationId, companyId: null }))
      .toEqual([expect.objectContaining({ email: "invited-by-platform@example.test", role: "administrator" })]);
    expect((await listAuditEvents(operator.client, target.organizationId))
      .filter((event) => event.action === "company.created" && event.targetId === created.value.id))
      .toEqual([expect.objectContaining({ actorUserId: operator.userId })]);
  });
  it("requires MFA at both visibility and command boundaries without expanding ordinary tenant access", async () => {
    const target = await administratorWithCompany("Isolated target");
    const operator = await provisionedUser("Unverified platform operator");
    const promoted = await systemClient().from("platform_user").insert({ user_id: operator.userId, role: "super_admin" });
    if (promoted.error) throw promoted.error;
    const ordinary = await provisionedUser("Ordinary outsider");
    const member = await companyMember(target);
    for (const actor of [operator, ordinary]) {
      expect(await getCompany(actor.client, target.companyId)).toBeNull();
      expect(await getMyCompanyRole(actor.client, target.companyId)).toBeNull();
      expect(await createCompany(actor.client, { organizationId: target.organizationId, ...companyDetails() }))
        .toEqual({ ok: false, error: "forbidden" });
      expect(await setOrganizationMfaRequired(actor.client, { organizationId: target.organizationId, required: true }))
        .toEqual({ ok: false, error: "forbidden" });
      expect((await actor.client.from("company").select("id").eq("id", target.companyId)).data).toEqual([]);
      const direct = await actor.client.rpc("set_organization_mfa_required", {
        target_organization_id: target.organizationId, required: true,
      });
      expect(direct.error?.code).toBe("42501");
    }
    expect(await getMyCompanyRole(member.client, target.companyId)).toBe("user");
    expect(await listMyOrganizations(member.client)).toEqual([
      expect.objectContaining({ id: member.organizationId }),
    ]);
  });

  it("uses normal upload, review and Finalization commands while preserving locks and archive safeguards", async () => {
    const target = await administratorWithCompany("Processing target");
    const operator = await promotedSuperAdministrator("Processing operator");
    const worker = testWorker();
    await assignAiConfigurationFixture(target.client, worker.jobs, { companyId: target.companyId, provider: worker.ai });
    const original = fixtureFile("receipt.png");
    const uploaded = await uploadSourceFile(operator.client, worker.jobs, {
      companyId: target.companyId, fileName: "receipt.png", bytes: original,
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    expect((await readSourceFile(operator.client, target.companyId, uploaded.value.id))?.bytes).toEqual(original);
    expect(await worker.runJobs()).toEqual([]);
    const [document] = await listDocuments(operator.client, target.companyId, uploaded.value.id);
    const period = { companyId: target.companyId, period: "2026-10" };
    expect((await generateVatReport(operator.client, period)).ok).toBe(true);
    expect(await finalizeVatReport(operator.client, { ...period, confirmed: true }))
      .toEqual({ ok: false, error: "readiness_blocked" });
    expect(await approveDocument(operator.client, {
      companyId: target.companyId, documentId: document.id, version: 1,
    })).toEqual({ ok: true, value: null });
    expect((await generateVatReport(operator.client, period)).ok).toBe(true);
    expect(await finalizeVatReport(operator.client, { ...period, confirmed: false }))
      .toEqual({ ok: false, error: "confirmation_required" });
    expect(await finalizeVatReport(operator.client, { ...period, confirmed: true }))
      .toEqual({ ok: true, value: null });
    expect(await getPeriodLock(operator.client, target.companyId, period.period))
      .toEqual(expect.objectContaining({ lockedBy: operator.userId }));
    expect(await returnDocumentToReview(operator.client, { companyId: target.companyId, documentId: document.id }))
      .toEqual({ ok: false, error: "period_locked" });
    expect(await unlockReportingPeriod(operator.client, { ...period, confirmed: false, reason: "Correction" }))
      .toEqual({ ok: false, error: "confirmation_required" });
    expect(await unlockReportingPeriod(operator.client, { ...period, confirmed: true, reason: "" }))
      .toEqual({ ok: false, error: "unlock_reason_required" });
    expect(await unlockReportingPeriod(operator.client, { ...period, confirmed: true, reason: "Correction" }))
      .toEqual({ ok: true, value: null });
    expect(await softDeleteCompany(operator.client, { companyId: target.companyId, exportId: crypto.randomUUID() }))
      .toEqual({ ok: false, error: "export_required" });
    const exported = await exportCompanyData(operator.client, worker.jobs, { companyId: target.companyId });
    if (!exported.ok) throw new Error(exported.error);
    expect(await softDeleteCompany(operator.client, { companyId: target.companyId, exportId: exported.value.exportId }))
      .toEqual({ ok: false, error: "export_required" });
    expect(await worker.runJobs()).toEqual([]);
    expect(await softDeleteCompany(operator.client, { companyId: target.companyId, exportId: exported.value.exportId }))
      .toEqual({ ok: true, value: { sourceFileCount: 1, documentCount: 1, approvedDocumentCount: 1, periodLockCount: 0 } });
    expect(await getCompany(operator.client, target.companyId)).toBeNull();
  });
  it("can inspect and change Organization MFA settings through the normal command", async () => {
    const target = await administratorWithCompany("MFA administration target");
    const operator = await promotedSuperAdministrator("MFA operator");
    expect(await listOrganizationMfaSettings(operator.client)).toContainEqual({
      id: target.organizationId, name: "MFA administration target", required: false,
    });
    expect(await setOrganizationMfaRequired(operator.client, {
      organizationId: target.organizationId, required: true,
    })).toEqual({ ok: true, value: null });
    expect(await listOrganizationMfaSettings(operator.client)).toContainEqual({
      id: target.organizationId, name: "MFA administration target", required: true,
    });
    expect((await listAuditEvents(operator.client, target.organizationId)).at(-1)).toEqual(expect.objectContaining({
      action: "organization.mfa_enforcement_changed", actorUserId: operator.userId,
      payload: { required: true },
    }));
  });
  it("discovers and administers another active tenant as the real actor without a Membership", async () => {
    const target = await administratorWithCompany("SuperAdmin target");
    const operator = await promotedSuperAdministrator("Operator Organization");

    expect(await listMyCompanies(operator.client)).toContainEqual({
      id: target.companyId, organizationId: target.organizationId, name: "Novák s.r.o.",
    });
    expect(await listMyOrganizations(operator.client)).toContainEqual({
      id: target.organizationId, name: "SuperAdmin target", role: "administrator",
    });
    expect(await getMyCompanyRole(operator.client, target.companyId)).toBe("administrator");
    const company = await getCompany(operator.client, target.companyId);
    expect(company).not.toBeNull();
    if (!company) throw new Error("Company is inaccessible");
    expect(await updateCompanyIdentity(operator.client, {
      ...company, companyId: company.id, name: "Updated by platform operator",
    })).toEqual({ ok: true, value: null });
    expect(await getCompany(target.client, target.companyId)).toEqual(expect.objectContaining({
      name: "Updated by platform operator",
    }));
    expect((await listAuditEvents(operator.client, target.organizationId)).at(-1)).toEqual(expect.objectContaining({
      actorUserId: operator.userId,
      action: "company.updated",
    }));
    const memberships = await operator.client.from("membership").select("id")
      .eq("organization_id", target.organizationId).eq("user_id", operator.userId);
    expect(memberships.error).toBeNull();
    expect(memberships.data).toEqual([]);
  });
});
