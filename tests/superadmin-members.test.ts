import { describe, expect, it } from "vitest";
import { acceptInvitation, generateInvitationLink, listCompanyAccess, listMemberships } from "@/application/memberships";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { provisionedUser } from "./support/clients";
import { aal2Client } from "./support/platform";
import { systemClient } from "./support/worker";
import { withPostgrestRowLimit } from "./support/postgrest";

describe("active tenant users exclude platform SuperAdmins", () => {
  it("omits historical Organization and Company Memberships without deleting or changing scoped access", async () => {
    const target = await administratorWithCompany("Historical platform Membership");
    const administrator = await provisionedUser("Ordinary Administrator");
    const member = await companyMember(target);
    const historicalCompanyMember = await companyMember(target);
    const invitation = await generateInvitationLink(target.client, {
      organizationId: target.organizationId, companyId: null, email: administrator.email,
      role: "administrator", acceptUrl: "http://localhost/invitations/accept",
    });
    if (!invitation.ok) throw new Error(invitation.error);
    expect(await acceptInvitation(administrator.client, invitation.value.token)).toEqual({ ok: true, value: null });
    const promoted = await systemClient().from("platform_user").insert([
      { user_id: target.userId, role: "super_admin" },
      { user_id: historicalCompanyMember.userId, role: "super_admin" },
    ]);
    if (promoted.error) throw promoted.error;
    expect(await listMemberships(target.client, { organizationId: target.organizationId, companyId: null })).toEqual([]);
    expect(await listCompanyAccess(target.client, target.companyId)).toEqual({ ok: false, error: "forbidden" });
    const operator = aal2Client(target.userId);

    for (const client of [administrator.client, operator]) {
      const memberships = await listMemberships(client, { organizationId: target.organizationId, companyId: null });
      expect(memberships).toEqual([expect.objectContaining({ userId: administrator.userId, role: "administrator" })]);
      const access = await listCompanyAccess(client, target.companyId);
      expect(access).toEqual({ ok: true, value: expect.any(Array) });
      if (!access.ok) throw new Error(access.error);
      expect(access.value).toHaveLength(2);
      expect(access.value.map(row => row.userId).sort()).toEqual([administrator.userId, member.userId].sort());
    }
    const retained = await operator.from("membership").select("user_id, role")
      .eq("organization_id", target.organizationId).in("user_id", [target.userId, historicalCompanyMember.userId]);
    expect(retained.error).toBeNull();
    expect(retained.data).toHaveLength(2);
    expect(retained.data).toEqual(expect.arrayContaining([
      { user_id: target.userId, role: "administrator" },
      { user_id: historicalCompanyMember.userId, role: "user" },
    ]));
    expect(await listMemberships(member.client, { organizationId: target.organizationId, companyId: null })).toEqual([]);
    expect(await listMemberships(member.client, { organizationId: target.organizationId, companyId: target.companyId }))
      .toEqual([expect.objectContaining({ userId: member.userId, role: "user" })]);
    const outsider = await provisionedUser("Unrelated Organization");
    expect(await listMemberships(outsider.client, { organizationId: target.organizationId, companyId: null })).toEqual([]);
    expect(await listCompanyAccess(outsider.client, target.companyId)).toEqual({ ok: false, error: "forbidden" });
  });

  it("keeps complete active rows and counts beyond the PostgREST response cap", async () => {
    const target = await administratorWithCompany("Complete active user counts");
    for (let index = 0; index < 4; index++) await companyMember(target);
    await withPostgrestRowLimit(2,
      () => target.client.from("membership").select("id").eq("organization_id", target.organizationId),
      async () => {
        expect(await listMemberships(target.client, { organizationId: target.organizationId, companyId: target.companyId }))
          .toHaveLength(4);
        const access = await listCompanyAccess(target.client, target.companyId);
        expect(access).toEqual({ ok: true, value: expect.any(Array) });
        if (!access.ok) throw new Error(access.error);
        expect(access.value).toHaveLength(5);
      });
  });
});
