import { expect, it } from "vitest";
import { createCompany } from "@/application/companies";
import { acceptInvitation, cancelInvitation, changeMembershipRole, generateInvitationLink, listAccessManagement, removeMembership, replaceInvitationLink } from "@/application/memberships";
import { exportCompanyData, softDeleteCompany } from "@/application/company-deletion";
import { setPlatformOrganizationBlocked } from "@/application/platform-administration";
import { provisionedUser } from "./support/clients";
import { promotedSuperAdministrator } from "./support/platform";
import { withPostgrestRowLimit } from "./support/postgrest";
import { systemClient, testWorker } from "./support/worker";
import { administratorWithCompany, companyDetails, companyMember } from "./support/fixtures";

it("groups one User's different Company Roles in authorized Organization scope and defaults Company queries precisely", async () => {
  const owner = await administratorWithCompany("Managed Organization");
  const created = await createCompany(owner.client, { organizationId: owner.organizationId, ...companyDetails({ name: "Second Company" }) });
  if (!created.ok) throw new Error(created.error);
  const member = await companyMember(owner);
  const invitation = await generateInvitationLink(owner.client, {
    organizationId: owner.organizationId, companyId: created.value.id, email: member.email,
    role: "administrator", acceptUrl: "http://localhost/invitations/accept",
  });
  if (!invitation.ok) throw new Error(invitation.error);
  expect(await acceptInvitation(member.client, invitation.value.token)).toEqual({ ok: true, value: null });
  const organization = await listAccessManagement(owner.client, { organizationId: owner.organizationId, companyId: null });
  if (!organization.ok) throw new Error(organization.error);
  expect(organization.value.scopes).toEqual([
    { organizationId: owner.organizationId, companyId: null, name: "Managed Organization" },
    { organizationId: owner.organizationId, companyId: owner.companyId, name: "Novák s.r.o." },
    { organizationId: owner.organizationId, companyId: created.value.id, name: "Second Company" },
  ]);
  expect(organization.value.users.filter(user => user.userId === member.userId)).toEqual([{
    userId: member.userId, email: member.email, effectiveRole: null,
    memberships: [
      expect.objectContaining({ companyId: owner.companyId, role: "user", manageable: true }),
      expect.objectContaining({ companyId: created.value.id, role: "administrator", manageable: true }),
    ],
  }]);
  const company = await listAccessManagement(owner.client, { organizationId: owner.organizationId, companyId: owner.companyId });
  if (!company.ok) throw new Error(company.error);
  expect(company.value.users.find(user => user.userId === member.userId)).toMatchObject({
    effectiveRole: "user", memberships: [{ companyId: owner.companyId, role: "user" }],
  });
});

it("offers Company Administrators only their managed Companies and refuses Organization/foreign scope RPC bypasses", async () => {
  const owner = await administratorWithCompany();
  const created = await createCompany(owner.client, { organizationId: owner.organizationId, ...companyDetails({ name: "Other Company" }) });
  if (!created.ok) throw new Error(created.error);
  const administrator = await companyMember(owner, "administrator");
  const access = await listAccessManagement(administrator.client, { organizationId: owner.organizationId, companyId: owner.companyId });
  if (!access.ok) throw new Error(access.error);
  expect(access.value.scopes).toEqual([{ organizationId: owner.organizationId, companyId: owner.companyId, name: "Novák s.r.o." }]);
  for (const companyId of [null, created.value.id]) {
    expect(await listAccessManagement(administrator.client, { organizationId: owner.organizationId, companyId })).toEqual({ ok: false, error: "forbidden" });
    expect((await administrator.client.rpc("list_access_management", { target_organization_id: owner.organizationId, target_company_id: companyId as string })).error?.code).toBe("42501");
  }
  const nextInvitation = await generateInvitationLink(owner.client, {
    organizationId: owner.organizationId, companyId: created.value.id, email: administrator.email,
    role: "administrator", acceptUrl: "http://localhost/invitations/accept",
  });
  if (!nextInvitation.ok) throw new Error(nextInvitation.error);
  expect(await acceptInvitation(administrator.client, nextInvitation.value.token)).toEqual({ ok: true, value: null });
  const expanded = await listAccessManagement(administrator.client, { organizationId: owner.organizationId, companyId: created.value.id });
  if (!expanded.ok) throw new Error(expanded.error);
  expect(expanded.value.scopes).toEqual([
    { organizationId: owner.organizationId, companyId: owner.companyId, name: "Novák s.r.o." },
    { organizationId: owner.organizationId, companyId: created.value.id, name: "Other Company" },
  ]);
  expect(await listAccessManagement(administrator.client, { organizationId: owner.organizationId, companyId: null })).toEqual({ ok: false, error: "forbidden" });
  const foreign = await administratorWithCompany("Foreign Organization");
  expect(await listAccessManagement(owner.client, { organizationId: foreign.organizationId, companyId: foreign.companyId })).toEqual({ ok: false, error: "forbidden" });
  expect(await listAccessManagement(owner.client, { organizationId: owner.organizationId, companyId: foreign.companyId })).toEqual({ ok: false, error: "forbidden" });
});


it("filters Invitations by the concrete scope and preserves Organization Administrator-only Invitation lifecycle", async () => {
  const owner = await administratorWithCompany();
  const administrator = await companyMember(owner, "administrator");
  const organizationInvitation = await generateInvitationLink(owner.client, {
    organizationId: owner.organizationId, companyId: null, email: "organization-invite@example.test", role: "administrator", acceptUrl: "http://localhost/invitations/accept",
  });
  const companyInvitation = await generateInvitationLink(owner.client, {
    organizationId: owner.organizationId, companyId: owner.companyId, email: "company-invite@example.test", role: "user", acceptUrl: "http://localhost/invitations/accept",
  });
  if (!organizationInvitation.ok || !companyInvitation.ok) throw new Error("Invitation fixture refused");
  const organization = await listAccessManagement(owner.client, { organizationId: owner.organizationId, companyId: null });
  const company = await listAccessManagement(administrator.client, { organizationId: owner.organizationId, companyId: owner.companyId });
  if (!organization.ok || !company.ok) throw new Error("Scope fixture refused");
  expect(organization.value.pendingInvitations).toEqual([expect.objectContaining({ email: "organization-invite@example.test", role: "administrator", status: "pending" })]);
  expect(company.value.pendingInvitations).toEqual([expect.objectContaining({ email: "company-invite@example.test", role: "user", status: "pending" })]);
  expect(await generateInvitationLink(owner.client, { organizationId: owner.organizationId, companyId: null, email: "invalid@example.test", role: "user", acceptUrl: "http://localhost/invitations/accept" })).toEqual({ ok: false, error: "invalid_invitation" });
  const id = organization.value.pendingInvitations[0].id;
  expect(await cancelInvitation(administrator.client, id)).toEqual({ ok: false, error: "forbidden" });
  expect(await replaceInvitationLink(administrator.client, { invitationId: id, acceptUrl: "http://localhost/invitations/accept" })).toEqual({ ok: false, error: "forbidden" });
  expect((await replaceInvitationLink(owner.client, { invitationId: id, acceptUrl: "http://localhost/invitations/accept" })).ok).toBe(true);
  expect(await cancelInvitation(owner.client, id)).toEqual({ ok: false, error: "invitation_replaced" });
  const replaced = await listAccessManagement(owner.client, { organizationId: owner.organizationId, companyId: null });
  if (!replaced.ok) throw new Error(replaced.error);
  const replacement = replaced.value.pendingInvitations.find(invitation => invitation.status === "pending")!;
  expect(await cancelInvitation(owner.client, replacement.id)).toEqual({ ok: true, value: null });
  const after = await listAccessManagement(owner.client, { organizationId: owner.organizationId, companyId: null });
  if (!after.ok) throw new Error(after.error);
  expect(after.value.pendingInvitations).toEqual([
    expect.objectContaining({ id, status: "replaced", token: null }),
    expect.objectContaining({ id: replacement.id, status: "cancelled", token: null }),
  ]);
});

it("retains Organization management with zero Companies and complete Users, Memberships, Invitations and scope choices above the response cap", async () => {
  const owner = await provisionedUser("No Companies yet");
  const empty = await listAccessManagement(owner.client, { organizationId: owner.organizationId, companyId: null });
  if (!empty.ok) throw new Error(empty.error);
  expect(empty.value.scopes).toEqual([{ organizationId: owner.organizationId, companyId: null, name: "No Companies yet" }]);
  expect(empty.value.users).toEqual([expect.objectContaining({ userId: owner.userId, effectiveRole: null })]);
  const companies: string[] = [];
  for (const name of ["First", "Second", "Third"]) {
    const result = await createCompany(owner.client, { organizationId: owner.organizationId, ...companyDetails({ name }) });
    if (!result.ok) throw new Error(result.error);
    companies.push(result.value.id);
  }
  const member = await companyMember({ organizationId: owner.organizationId, companyId: companies[0] });
  for (const companyId of companies.slice(1)) {
    const invitation = await generateInvitationLink(owner.client, { organizationId: owner.organizationId, companyId, email: member.email, role: "administrator", acceptUrl: "http://localhost/invitations/accept" });
    if (!invitation.ok) throw new Error(invitation.error);
    expect((await acceptInvitation(member.client, invitation.value.token)).ok).toBe(true);
  }
  await companyMember({ organizationId: owner.organizationId, companyId: companies[0] });
  for (const email of ["first@example.test", "second@example.test", "third@example.test"]) {
    expect((await generateInvitationLink(owner.client, { organizationId: owner.organizationId, companyId: null, email, role: "administrator", acceptUrl: "http://localhost/invitations/accept" })).ok).toBe(true);
  }
  await withPostgrestRowLimit(2, () => owner.client.from("membership").select("id").eq("organization_id", owner.organizationId), async () => {
    const result = await listAccessManagement(owner.client, { organizationId: owner.organizationId, companyId: null });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.scopes).toHaveLength(4);
    expect(result.value.users).toHaveLength(3);
    expect(result.value.users.find(user => user.userId === member.userId)?.memberships).toHaveLength(3);
    expect(result.value.pendingInvitations).toHaveLength(3);
  });
});

it("uses membership-free AAL2 SuperAdmin context for blocked tenants while preserving deleted Company safeguards", async () => {
  const owner = await administratorWithCompany("Blocked context");
  const member = await companyMember(owner);
  const platform = await promotedSuperAdministrator("Platform operator");
  expect(await setPlatformOrganizationBlocked(platform.client, { organizationId: owner.organizationId, blocked: true })).toEqual({ ok: true, value: null });
  expect(await listAccessManagement(owner.client, { organizationId: owner.organizationId, companyId: null })).toEqual({ ok: false, error: "forbidden" });
  for (const companyId of [null, owner.companyId]) {
    const access = await listAccessManagement(platform.client, { organizationId: owner.organizationId, companyId });
    if (!access.ok) throw new Error(access.error);
    expect(access.value.blocked).toBe(true);
    expect(access.value.users.map(user => user.userId).sort()).toEqual([owner.userId, member.userId].sort());
    const membership = access.value.users.find(user => user.userId === member.userId)!.memberships[0];
    expect(await changeMembershipRole(platform.client, { membershipId: membership.id, role: "administrator" })).toEqual({ ok: true, value: null });
  }
  const unverified = await provisionedUser("AAL1 operator");
  const promoted = await systemClient().from("platform_user").insert({ user_id: unverified.userId, role: "super_admin" });
  if (promoted.error) throw promoted.error;
  expect(await listAccessManagement(unverified.client, { organizationId: owner.organizationId, companyId: null })).toEqual({ ok: false, error: "forbidden" });
  const worker = testWorker();
  expect(await exportCompanyData(platform.client, worker.jobs, { companyId: owner.companyId })).toEqual({ ok: false, error: "forbidden" });
  expect(await setPlatformOrganizationBlocked(platform.client, { organizationId: owner.organizationId, blocked: false })).toEqual({ ok: true, value: null });
  const exported = await exportCompanyData(platform.client, worker.jobs, { companyId: owner.companyId });
  if (!exported.ok) throw new Error(exported.error);
  expect(await worker.runJobs()).toEqual([]);
  expect((await softDeleteCompany(platform.client, { companyId: owner.companyId, exportId: exported.value.exportId })).ok).toBe(true);
  expect(await listAccessManagement(platform.client, { organizationId: owner.organizationId, companyId: owner.companyId })).toEqual({ ok: false, error: "forbidden" });
  const remaining = await listAccessManagement(platform.client, { organizationId: owner.organizationId, companyId: null });
  if (!remaining.ok) throw new Error(remaining.error);
  expect(remaining.value.scopes).toHaveLength(1);
  expect(remaining.value.users.map(user => user.userId)).toEqual([owner.userId]);
  // Exact direct target remains immutable even through the Organization filter.
  const retained = await platform.client.from("membership").select("id").eq("user_id", member.userId).eq("company_id", owner.companyId).single();
  if (retained.error) throw retained.error;
  expect(await removeMembership(platform.client, retained.data.id)).toEqual({ ok: false, error: "forbidden" });
});
