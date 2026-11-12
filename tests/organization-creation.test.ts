import { describe, expect, it } from "vitest";
import { createOrganization, listMyOrganizations } from "@/application/organizations";
import { listPlatformOrganizationCompanies } from "@/application/platform-administration";
import { listAuditEvents } from "@/application/audit";
import { acceptInvitation, generateInvitationLink, listMemberships, listPendingInvitations } from "@/application/memberships";
import { createCompanyIdentity, getCompany } from "@/application/companies";
import { administratorWithCompany, companyDetails, companyMember } from "./support/fixtures";
import { anonymousClient, provisionedUser } from "./support/clients";
import { promotedSuperAdministrator } from "./support/platform";

describe("SuperAdmin Organization creation", () => {
  it("creates an active empty Organization under the actual platform identity", async () => {
    const operator = await promotedSuperAdministrator("Platform operator");
    const created = await createOrganization(operator.client, { name: "  New accounting office  " });
    expect(created).toEqual({ ok: true, value: { id: expect.any(String), name: "New accounting office" } });
    if (!created.ok) throw new Error(created.error);
    const { id } = created.value;
    expect(await listPlatformOrganizationCompanies(operator.client)).toEqual(expect.objectContaining({
      ok: true, value: expect.arrayContaining([{ id, name: "New accounting office", blocked: false, companies: [] }]),
    }));
    expect(await listMyOrganizations(operator.client)).toContainEqual({ id, name: "New accounting office", role: "administrator" });
    expect(await listMemberships(operator.client, { organizationId: id, companyId: null })).toEqual([]);
    expect(await listPendingInvitations(operator.client, { organizationId: id, companyId: null })).toEqual([]);
    expect(await listAuditEvents(operator.client, id)).toEqual([expect.objectContaining({
      action: "organization.created", actorUserId: operator.userId, organizationId: id,
      companyId: null, targetType: "organization", targetId: id, payload: {},
    })]);
  });
  it("refuses whitespace-only names at both command and direct RPC boundaries", async () => {
    const operator = await promotedSuperAdministrator("Blank-name operator");
    const before = await listPlatformOrganizationCompanies(operator.client);
    for (const name of ["", "   ", "\t\n", "\u00a0"]) {
      expect(await createOrganization(operator.client, { name })).toEqual({ ok: false, error: "organization_name_required" });
      const direct = await operator.client.rpc("create_organization", { organization_name: name });
      expect(direct.error).toEqual(expect.objectContaining({ code: "P0001", hint: "organization_name_required" }));
    }
    expect(await listPlatformOrganizationCompanies(operator.client)).toEqual(before);
  });
  it("refuses anonymous, ordinary, scoped Administrator and weak SuperAdmin requests without writes", async () => {
    const administrator = await administratorWithCompany("Scoped authority");
    const ordinary = await companyMember(administrator);
    const operator = await promotedSuperAdministrator("Audit observer");
    const weak = anonymousClient();
    const weakSession = await weak.auth.signInWithPassword({ email: operator.email, password: "correct-horse-battery" });
    expect(weakSession.error).toBeNull();
    expect((await weak.auth.mfa.getAuthenticatorAssuranceLevel()).data?.currentLevel).toBe("aal1");
    const before = await listPlatformOrganizationCompanies(operator.client);
    const auditBefore = await operator.client.from("audit_event").select("id").eq("action", "organization.created");
    for (const client of [anonymousClient(), ordinary.client, administrator.client, weak]) {
      expect(await createOrganization(client, { name: "Forbidden Organization" })).toEqual({ ok: false, error: "forbidden" });
      const direct = await client.rpc("create_organization", { organization_name: "Forbidden direct Organization" });
      expect(direct.error?.code).toBe("42501");
      // There is no broad INSERT grant which could bypass the audited command.
      const insert = await client.from("organization").insert({ name: "Forbidden table Organization" });
      expect(insert.error?.code).toBe("42501");
    }
    expect(await listPlatformOrganizationCompanies(operator.client)).toEqual(before);
    expect(await operator.client.from("audit_event").select("id").eq("action", "organization.created")).toEqual(auditBefore);
  });

  it("creates the first Company before inviting its Administrator through the existing flow", async () => {
    const operator = await promotedSuperAdministrator("Pilot operator");
    const created = await createOrganization(operator.client, { name: "Independent customer" });
    if (!created.ok) throw new Error(created.error);
    const organizationId = created.value.id;
    const company = await createCompanyIdentity(operator.client, { organizationId, ...companyDetails() });
    expect(company).toEqual({ ok: true, value: { id: expect.any(String) } });
    if (!company.ok) throw new Error(company.error);
    expect(await getCompany(operator.client, company.value.id)).toEqual(expect.objectContaining({ organizationId }));
    expect(await listMemberships(operator.client, { organizationId, companyId: null })).toEqual([]);
    const futureAdministrator = await provisionedUser("Future Administrator own Organization");
    expect(await listMyOrganizations(futureAdministrator.client)).not.toContainEqual(expect.objectContaining({ id: organizationId }));
    const invitation = await generateInvitationLink(operator.client, {
      organizationId, companyId: null, email: futureAdministrator.email, role: "administrator", acceptUrl: "http://localhost/accept-invitation",
    });
    if (!invitation.ok) throw new Error(invitation.error);
    expect(await acceptInvitation(futureAdministrator.client, invitation.value.token)).toEqual({ ok: true, value: null });
    expect(await listMyOrganizations(futureAdministrator.client)).toContainEqual({ id: organizationId, name: "Independent customer", role: "administrator" });
    expect(await listMemberships(operator.client, { organizationId, companyId: null })).toEqual([expect.objectContaining({ userId: futureAdministrator.userId, role: "administrator" })]);
  });

  it("preserves name letters while trimming all supported surrounding whitespace in direct RPC", async () => {
    const operator = await promotedSuperAdministrator("Whitespace operator");
    const direct = await operator.client.rpc("create_organization", { organization_name: "\v\u00a0vivid\u00a0\v" });
    expect(direct.error).toBeNull();
    expect(await listMyOrganizations(operator.client)).toContainEqual({ id: direct.data, name: "vivid", role: "administrator" });
  });

});
