import { organizationCompanyRowLimitProbe, withPostgrestRowLimit } from "./support/postgrest";
import { beginTotpEnrollment, completeTotpEnrollment, setOrganizationMfaRequired } from "@/application/mfa";
import { createOrganization } from "@/application/organizations";
import { createCompany } from "@/application/companies";
import { provisionedUser } from "./support/clients";
import { promoteSuperAdministratorFixture } from "./support/platform";
import { totp } from "./support/totp";
import { succeeded } from "./support/results";
import { expect, it } from "vitest";
import { listAuditEvents } from "@/application/audit";
import { previewMembershipChange, acceptInvitation, generateInvitationLink, changeMembershipRole, listCompanyAccess, listMemberships, removeMembership } from "@/application/memberships";
import { administratorWithCompany, companyMember, companyDetails } from "./support/fixtures";

it("refuses self-removal and self-demotion without durable changes or success audit", async () => {
  const owner = await administratorWithCompany();
  const member = await companyMember(owner, "administrator");
  const [membership] = await listMemberships(owner.client, owner);
  const before = await listAuditEvents(owner.client, owner.organizationId);
  expect(await removeMembership(member.client, membership.id)).toEqual({ ok: false, error: "membership_self_change" });
  expect(await changeMembershipRole(member.client, { membershipId: membership.id, role: "user" })).toEqual({ ok: false, error: "membership_self_change" });
  expect(await listMemberships(owner.client, owner)).toEqual([membership]);
  expect(await listAuditEvents(owner.client, owner.organizationId)).toEqual(before);
});

it("preserves last Organization and effective Company administration, counting distinct Users across paths", async () => {
  const owner = await administratorWithCompany();
  const operator = await superAdministrator();
  const [organizationMembership] = await listMemberships(operator.client, { organizationId: owner.organizationId, companyId: null });
  expect(await removeMembership(operator.client, organizationMembership.id)).toEqual({ ok: false, error: "membership_last_administrator" });
  const member = await companyMember(owner, "administrator");
  const [direct] = await listMemberships(owner.client, owner);
  // The Organization Administrator is a different administering User, so this is safe.
  expect(await changeMembershipRole(owner.client, { membershipId: direct.id, role: "user" })).toEqual({ ok: true, value: null });
  const empty = succeeded(await createOrganization(operator.client, { name: "Initially empty" }));
  expect(await listMemberships(operator.client, { organizationId: empty.id, companyId: null })).toEqual([]);
  const company = succeeded(await createCompany(operator.client, { organizationId: empty.id, ...companyDetails() }));
  const first = await companyMember({ organizationId: empty.id, companyId: company.id }, "administrator");
  const [last] = await listMemberships(operator.client, { organizationId: empty.id, companyId: company.id });
  expect(await changeMembershipRole(operator.client, { membershipId: last.id, role: "user" })).toEqual({ ok: false, error: "membership_last_administrator" });
  expect(await removeMembership(operator.client, last.id)).toEqual({ ok: false, error: "membership_last_administrator" });
  // Platform authority is not a synthetic scoped Administrator.
  expect((await listMemberships(operator.client, { organizationId: empty.id, companyId: company.id })).map(m => m.userId)).toEqual([first.userId]);
  const firstInvitation = succeeded(await generateInvitationLink(operator.client, { organizationId: empty.id, companyId: null, email: first.email, role: "administrator", acceptUrl: "http://localhost/invitations/accept" }));
  succeeded(await acceptInvitation(first.client, firstInvitation.token));
  expect((await listMemberships(operator.client, { organizationId: empty.id, companyId: null })).map(membership => membership.userId)).toEqual([first.userId]);
  // Two paths belonging to this one User preserve Company access when only the
  // direct path is demoted, but do not provide a second Organization Administrator.
  succeeded(await changeMembershipRole(operator.client, { membershipId: last.id, role: "user" }));
  const [onlyOrganizationAdministrator] = await listMemberships(operator.client, { organizationId: empty.id, companyId: null });
  expect(await removeMembership(operator.client, onlyOrganizationAdministrator.id)).toEqual({ ok: false, error: "membership_last_administrator" });
  expect(member.userId).not.toBe(owner.userId);
});

async function superAdministrator() {
  const user = await provisionedUser("Safety platform operator");
  const enrollment = succeeded(await beginTotpEnrollment(user.client));
  succeeded(await completeTotpEnrollment(user.client, { factorId: enrollment.factorId, code: totp(enrollment.secret) }));
  await promoteSuperAdministratorFixture(user.userId);
  return user;
}

it.each(["remove", "demote"] as const)("serializes concurrent authenticated Company %s commands and retains one Administrator", async operation => {
  const platform = await superAdministrator();
  const otherPlatform = await superAdministrator();
  const empty = succeeded(await createOrganization(platform.client, { name: "Concurrent administration" }));
  const company = succeeded(await createCompany(platform.client, { organizationId: empty.id, ...companyDetails() }));
  await companyMember({ organizationId: empty.id, companyId: company.id }, "administrator");
  await companyMember({ organizationId: empty.id, companyId: company.id }, "administrator");
  const scope = { organizationId: empty.id, companyId: company.id };
  const [first, second] = await listMemberships(platform.client, scope);
  const before = await listAuditEvents(platform.client, empty.id);
  const results = await Promise.all([platform.client, otherPlatform.client].map((client, index) => operation === "remove"
    ? removeMembership(client, [first, second][index].id)
    : changeMembershipRole(client, { membershipId: [first, second][index].id, role: "user" })));
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.find(result => !result.ok)).toEqual({ ok: false, error: "membership_last_administrator" });
  const remaining = await listMemberships(platform.client, scope);
  expect(remaining.filter(membership => membership.role === "administrator")).toHaveLength(1);
  const newEvents = (await listAuditEvents(platform.client, empty.id)).slice(before.length);
  expect(newEvents.map(event => event.action)).toEqual([operation === "remove" ? "membership.removed" : "membership.role_changed"]);
});

it("serializes Organization removals, retains inherited administration and does not count duplicated paths as people", async () => {
  const owner = await administratorWithCompany();
  const second = await companyMember(owner, "administrator");
  const token = succeeded(await generateInvitationLink(owner.client, { organizationId: owner.organizationId, companyId: null, email: second.email, role: "administrator", acceptUrl: "http://localhost/invitations/accept" }));
  succeeded(await acceptInvitation(second.client, token.token));
  const platform = await superAdministrator();
  const members = await listMemberships(platform.client, { organizationId: owner.organizationId, companyId: null });
  const results = await Promise.all(members.map(membership => removeMembership(platform.client, membership.id)));
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.find(result => !result.ok)).toEqual({ ok: false, error: "membership_last_administrator" });
  const remaining = succeeded(await listCompanyAccess(platform.client, owner.companyId));
  expect(new Set(remaining.filter(user => user.role === "administrator").map(user => user.userId)).size).toBeGreaterThanOrEqual(1);
});

it("applies self-change to concrete SuperAdmin Memberships and inherited/direct duplicates", async () => {
  const owner = await administratorWithCompany();
  const direct = await companyMember(owner, "administrator");
  const token = succeeded(await generateInvitationLink(owner.client, { organizationId: owner.organizationId, companyId: null, email: direct.email, role: "administrator", acceptUrl: "http://localhost/invitations/accept" }));
  succeeded(await acceptInvitation(direct.client, token.token));
  const membership = (await listMemberships(owner.client, owner))[0];
  for (const promote of [false, true]) {
    if (promote) {
      const enrollment = succeeded(await beginTotpEnrollment(direct.client));
      succeeded(await completeTotpEnrollment(direct.client, { factorId: enrollment.factorId, code: totp(enrollment.secret) }));
      await promoteSuperAdministratorFixture(direct.userId);
    }
    const before = await listAuditEvents(owner.client, owner.organizationId);
    expect(await removeMembership(direct.client, membership.id)).toEqual({ ok: false, error: "membership_self_change" });
    expect(await changeMembershipRole(direct.client, { membershipId: membership.id, role: "user" })).toEqual({ ok: false, error: "membership_self_change" });
    expect((await direct.client.rpc("remove_membership", { target_membership_id: membership.id })).error?.hint).toBe("membership_self_change");
    expect(await listAuditEvents(owner.client, owner.organizationId)).toEqual(before);
  }
});

it("previews exact Organization impact without writes, retains other paths and refuses a stale confirmation", async () => {
  const owner = await administratorWithCompany("Impact Organization");
  const secondCompany = succeeded(await createCompany(owner.client, { organizationId: owner.organizationId, ...companyDetails({ name: "Z Second Company" }) }));
  const other = await companyMember(owner);
  const token = succeeded(await generateInvitationLink(owner.client, { organizationId: owner.organizationId, companyId: null, email: other.email, role: "administrator", acceptUrl: "http://localhost/invitations/accept" }));
  succeeded(await acceptInvitation(other.client, token.token));
  const membership = (await listMemberships(owner.client, { organizationId: owner.organizationId, companyId: null })).find(m => m.userId === other.userId)!;
  const direct = (await listMemberships(owner.client, owner))[0];
  const before = await listAuditEvents(owner.client, owner.organizationId);
  const impact = succeeded(await previewMembershipChange(owner.client, { membershipId: membership.id, role: null }));
  expect(impact.membership).toEqual({ ...membership, scopeName: "Impact Organization" });
  expect(impact.role).toBeNull();
  expect(impact.companies).toEqual([
    { companyId: owner.companyId, name: "Novák s.r.o.", role: "user", memberships: [{ id: direct.id, source: "company", role: "user", scopeName: "Novák s.r.o." }] },
    { companyId: secondCompany.id, name: "Z Second Company", role: null, memberships: [] },
  ]);
  // Reviewing and then cancelling means no mutation command is invoked.
  expect(await listAuditEvents(owner.client, owner.organizationId)).toEqual(before);
  expect(await listMemberships(owner.client, { organizationId: owner.organizationId, companyId: null })).toContainEqual(membership);
  succeeded(await changeMembershipRole(owner.client, { membershipId: direct.id, role: "administrator" }));
  expect(await removeMembership(owner.client, membership.id, impact.confirmationToken)).toEqual({ ok: false, error: "membership_change_stale" });
  const refreshed = succeeded(await previewMembershipChange(owner.client, { membershipId: membership.id, role: null }));
  expect(refreshed.companies[0].role).toBe("administrator");
  succeeded(await removeMembership(owner.client, membership.id, refreshed.confirmationToken));
  expect((await listMemberships(owner.client, { organizationId: owner.organizationId, companyId: null })).map(m => m.id)).not.toContain(membership.id);
  expect(succeeded(await listCompanyAccess(owner.client, owner.companyId)).find(u => u.userId === other.userId)).toMatchObject({ role: "administrator", source: "company" });
});

it("cannot accept an Invitation to bypass self-demotion of an existing Administrator Membership", async () => {
  const owner = await administratorWithCompany();
  const member = await companyMember(owner, "administrator");
  const token = succeeded(await generateInvitationLink(owner.client, { organizationId: owner.organizationId, companyId: owner.companyId, email: member.email, role: "user", acceptUrl: "http://localhost/invitations/accept" }));
  const before = await listAuditEvents(owner.client, owner.organizationId);
  expect(await acceptInvitation(member.client, token.token)).toEqual({ ok: false, error: "membership_self_change" });
  expect((await listMemberships(owner.client, owner))[0].role).toBe("administrator");
  expect(await listAuditEvents(owner.client, owner.organizationId)).toEqual(before);
});

it("keeps impact and confirmation tenant-isolated and enforces required MFA on direct calls", async () => {
  const owner = await administratorWithCompany();
  const other = await companyMember(owner);
  const foreign = await administratorWithCompany("Foreign safety scope");
  const [membership] = await listMemberships(owner.client, owner);
  const impact = succeeded(await previewMembershipChange(owner.client, { membershipId: membership.id, role: null }));
  for (const client of [foreign.client, other.client]) {
    expect(await previewMembershipChange(client, { membershipId: membership.id, role: null })).toEqual({ ok: false, error: "forbidden" });
    expect(await removeMembership(client, membership.id, impact.confirmationToken)).toEqual({ ok: false, error: "forbidden" });
    expect((await client.rpc("preview_membership_change", { target_membership_id: membership.id, next_role: null as unknown as "user" })).error?.code).toBe("42501");
  }
  const scopedAdministrator = await companyMember(owner, "administrator");
  succeeded(await setOrganizationMfaRequired(owner.client, { organizationId: owner.organizationId, required: true }));
  expect(await previewMembershipChange(scopedAdministrator.client, { membershipId: membership.id, role: null })).toEqual({ ok: false, error: "forbidden" });
  expect(await removeMembership(scopedAdministrator.client, membership.id)).toEqual({ ok: false, error: "forbidden" });
  expect(await changeMembershipRole(scopedAdministrator.client, { membershipId: membership.id, role: "administrator" })).toEqual({ ok: false, error: "forbidden" });
});

it("previews every affected Company beyond the response cap and preserves inherited access after a direct reduction", async () => {
  const owner = await administratorWithCompany("Complete impact");
  for (const name of ["Second", "Third"]) succeeded(await createCompany(owner.client, { organizationId: owner.organizationId, ...companyDetails({ name }) }));
  const member = await companyMember(owner, "administrator");
  const invitation = succeeded(await generateInvitationLink(owner.client, { organizationId: owner.organizationId, companyId: null, email: member.email, role: "administrator", acceptUrl: "http://localhost/invitations/accept" }));
  succeeded(await acceptInvitation(member.client, invitation.token));
  const [direct] = await listMemberships(owner.client, owner);
  const inherited = (await listMemberships(owner.client, { organizationId: owner.organizationId, companyId: null })).find(m => m.userId === member.userId)!;
  await withPostgrestRowLimit(1, organizationCompanyRowLimitProbe(owner.client, owner.organizationId), async () => {
    const impact = succeeded(await previewMembershipChange(owner.client, { membershipId: inherited.id, role: null }));
    expect(impact.companies.map(company => company.name)).toEqual(["Novák s.r.o.", "Second", "Third"]);
    const directImpact = succeeded(await previewMembershipChange(owner.client, { membershipId: direct.id, role: "user" }));
    expect(directImpact.companies).toEqual([{ companyId: owner.companyId, name: "Novák s.r.o.", role: "administrator", memberships: [
      { id: inherited.id, source: "organization", role: "administrator", scopeName: "Complete impact" },
      { id: direct.id, source: "company", role: "user", scopeName: "Novák s.r.o." },
    ] }]);
    succeeded(await changeMembershipRole(owner.client, { membershipId: direct.id, role: "user", confirmationToken: directImpact.confirmationToken }));
    expect(succeeded(await listCompanyAccess(owner.client, owner.companyId)).find(user => user.userId === member.userId)?.role).toBe("administrator");
  });
});
