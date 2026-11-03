import { succeeded } from "./support/results";
import { describe, expect, it } from "vitest";
import { listMyOrganizations } from "@/application/organizations";
import { getCompany, listMyCompanies } from "@/application/companies";
import { listAuditEvents } from "@/application/audit";
import { setOrganizationMfaRequired } from "@/application/mfa";
import { setPlatformOrganizationBlocked } from "@/application/platform-administration";
import { listSourceFiles, uploadSourceFile } from "@/application/source-files";
import { finalizeVatReport, generateVatReport } from "@/application/vat-reports";
import { administratorWithCompany, assignAiConfigurationFixture, companyMember } from "./support/fixtures";
import { promotedSuperAdministrator } from "./support/platform";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";
import { exportCompanyData, softDeleteCompany } from "@/application/company-deletion";
import { downloadPlatformCompanyHistory, getPlatformCompanyHistory, readPlatformCompanyArtifact, readPlatformCompanySourceFile } from "@/application/platform-company-history";
import { strFromU8, unzipSync } from "fflate";
import { provisionedUser } from "./support/clients";
import { systemClient } from "./support/worker";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { exportVatReport } from "@/application/epo-export";
import { cancelInvitation, changeMembershipRole, getInvitationOnboarding, inviteMember, listCompanyAccess, listMemberships, listPendingInvitations, removeMembership, replaceInvitationLink } from "@/application/memberships";

describe("SuperAdmin support for unavailable tenants", () => {
  it("preserves archived XML downloads after deletion and refuses an artifact belonging to another Company", async () => {
    const target = await administratorWithCompany("Archived XML history");
    const other = await administratorWithCompany("Other XML history");
    const operator = await promotedSuperAdministrator("XML history operator");
    expect(await saveCompanyFilingDefaults(target.client, {
      companyId: target.companyId, taxOffice: "451", territorialOffice: "2003", economicActivity: "621000",
      signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
      email: "podatelna@example.test", phone: "+420123456789", epoAddressOverride: null,
    })).toEqual({ ok: true, value: null });
    expect((await generateVatReport(target.client, { companyId: target.companyId, period: "2026-10" })).ok).toBe(true);
    const xml = await exportVatReport(target.client, {
      companyId: target.companyId, period: "2026-10", format: "dphdp3", details: { preparedOn: "2026-10-29" },
    });
    if (!xml.ok) throw new Error(xml.error);
    const worker = testWorker();
    const exported = await exportCompanyData(operator.client, worker.jobs, { companyId: target.companyId });
    if (!exported.ok) throw new Error(exported.error);
    expect(await worker.runJobs()).toEqual([]);
    expect((await softDeleteCompany(operator.client, { companyId: target.companyId, exportId: exported.value.exportId })).ok)
      .toBe(true);
    expect(await readPlatformCompanyArtifact(operator.client, { companyId: target.companyId, artifactId: xml.value.artifactId }))
      .toEqual({ ok: true, value: { bytes: xml.value.bytes, fileName: xml.value.fileName, mediaType: xml.value.mediaType } });
    expect(await readPlatformCompanyArtifact(operator.client, { companyId: other.companyId, artifactId: xml.value.artifactId }))
      .toEqual({ ok: false, error: "forbidden" });
    const archive = await downloadPlatformCompanyHistory(operator.client, target.companyId);
    if (!archive.ok) throw new Error(archive.error);
    expect(unzipSync(archive.value.bytes)[`vat-report-artifacts/${xml.value.artifactId}/${xml.value.fileName}`])
      .toEqual(xml.value.bytes);
  });
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
    expect(await listMyCompanies(operator.client)).not.toContainEqual(expect.objectContaining({ id: target.companyId }));
    expect(await listMyCompanies(target.client)).toEqual([]);
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
    const unverified = await provisionedUser("Unverified support operator");
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
    const member = await companyMember(target);
    const unverified = await provisionedUser("Unverified blocked support");
    const promoted = await systemClient().from("platform_user").insert({ user_id: unverified.userId, role: "super_admin" });
    if (promoted.error) throw promoted.error;
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
    expect(await listMemberships(operator.client, { organizationId: target.organizationId, companyId: null }))
      .toEqual([expect.objectContaining({ userId: target.userId, email: target.email, role: "administrator" })]);
    const companyMemberships = await listMemberships(operator.client, { organizationId: target.organizationId, companyId: target.companyId });
    expect(companyMemberships).toEqual([expect.objectContaining({ userId: member.userId, email: member.email, role: "user" })]);
    const membershipId = companyMemberships[0].id;
    expect(await listCompanyAccess(operator.client, target.companyId)).toEqual({ ok: true, value: expect.arrayContaining([
      expect.objectContaining({ email: target.email, source: "organization" }),
      expect.objectContaining({ email: member.email, source: "company", role: "user" }),
    ]) });
    for (const actor of [target, member, unverified]) {
      expect((await actor.client.from("membership").select("id").eq("organization_id", target.organizationId)).data).toEqual([]);
      expect(await changeMembershipRole(actor.client, { membershipId, role: "administrator" }))
        .toEqual({ ok: false, error: "forbidden" });
    }
    expect(await changeMembershipRole(operator.client, { membershipId, role: "administrator" }))
      .toEqual({ ok: true, value: null });
    expect(await listMemberships(operator.client, { organizationId: target.organizationId, companyId: target.companyId }))
      .toEqual([expect.objectContaining({ userId: member.userId, role: "administrator" })]);
    expect(await inviteMember(operator.client, { async sendInvitation() {} }, {
      organizationId: target.organizationId, companyId: target.companyId, role: "user",
      email: "blocked-support-invite@example.test", acceptUrl: "http://localhost/invitations/accept",
    })).toEqual({ ok: true, value: null });
    expect(await inviteMember(operator.client, { async sendInvitation() { throw new Error("mail delivery failed"); } }, {
      organizationId: target.organizationId, companyId: target.companyId, role: "user",
      email: "cancelled-blocked-support@example.test", acceptUrl: "http://localhost/invitations/accept",
    })).toEqual({ ok: false, error: "invitation_failed" });
    const scope = { organizationId: target.organizationId, companyId: target.companyId };
    const invitations = await listPendingInvitations(operator.client, scope);
    expect(invitations).toEqual([
      expect.objectContaining({ email: "blocked-support-invite@example.test", status: "pending" }),
      expect.objectContaining({ email: "cancelled-blocked-support@example.test", status: "cancelled", token: null }),
    ]);
    const pending = invitations[0];
    for (const actor of [target, member, unverified]) {
      expect(await inviteMember(actor.client, { async sendInvitation() {} }, {
        ...scope, role: "user", email: "refused-blocked-support@example.test", acceptUrl: "http://localhost/invitations/accept",
      })).toEqual({ ok: false, error: "forbidden" });
      expect(await listPendingInvitations(actor.client, scope)).toEqual([]);
      expect(await replaceInvitationLink(actor.client, { invitationId: pending.id, acceptUrl: "http://localhost/invitations/accept" }))
        .toEqual({ ok: false, error: "forbidden" });
      expect(await cancelInvitation(actor.client, pending.id)).toEqual({ ok: false, error: "forbidden" });
    }
    const replacement = await replaceInvitationLink(operator.client, { invitationId: pending.id, acceptUrl: "http://localhost/invitations/accept" });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok || !pending.token) throw new Error("Support replacement invitation was not created");
    expect(succeeded(await getInvitationOnboarding(operator.client, pending.token))).toEqual({ status: "replaced" });
    expect(succeeded(await getInvitationOnboarding(operator.client, replacement.value.token))).toMatchObject({ status: "valid" });
    expect(await removeMembership(operator.client, membershipId)).toEqual({ ok: true, value: null });
    expect(await listMemberships(operator.client, { organizationId: target.organizationId, companyId: target.companyId })).toEqual([]);
    expect((await listAuditEvents(operator.client, target.organizationId))
      .filter((event) => ["membership.role_changed", "membership.removed"].includes(event.action)))
      .toEqual([
        expect.objectContaining({ action: "membership.role_changed", actorUserId: operator.userId }),
        expect.objectContaining({ action: "membership.removed", actorUserId: operator.userId }),
      ]);
    expect(await listMyOrganizations(target.client)).toEqual([]);
    expect(await getCompany(target.client, target.companyId)).toBeNull();
    expect(await listMyCompanies(operator.client)).not.toContainEqual(expect.objectContaining({ id: target.companyId }));
    expect(await listMyCompanies(member.client)).toEqual([]);
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
