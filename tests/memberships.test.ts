import { describe, expect, it } from "vitest";
import { signUp } from "@/application/auth";
import { listAuditEvents } from "@/application/audit";
import {
  acceptInvitation,
  changeMembershipRole,
  inviteMember,
  listCompanyAccess,
  listMemberships,
  listPendingInvitations,
  removeMembership,
  type InvitationMailer,
} from "@/application/memberships";
import { listMyCompanies } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { anonymousClient, uniqueEmail } from "./support/clients";
import { administratorWithCompany, companyDetails } from "./support/fixtures";
import { createCompany } from "@/application/companies";

function capturingMailer() {
  const sent: { email: string; acceptUrl: string }[] = [];
  const mailer: InvitationMailer = {
    async sendInvitation(message) {
      sent.push(message);
    },
  };
  return { mailer, sent };
}

async function invitedUser(email: string) {
  const client = anonymousClient();
  const result = await signUp(client, {
    email,
    password: "correct-horse-battery",
    organizationName: "Ignored for invited users",
  });
  if (!result.ok) throw new Error(result.error);
  return { client, userId: result.value.userId };
}

async function inviteAndAccept(
  administrator: Awaited<ReturnType<typeof administratorWithCompany>>,
  role: "administrator" | "user" = "user",
) {
  const email = uniqueEmail();
  const mail = capturingMailer();
  const result = await inviteMember(administrator.client, mail.mailer, {
    organizationId: administrator.organizationId,
    companyId: administrator.companyId,
    email,
    role,
    acceptUrl: "http://127.0.0.1:3100/invitations/accept",
  });
  if (!result.ok) throw new Error(result.error);
  const user = await invitedUser(email);
  const token = new URL(mail.sent[0].acceptUrl).searchParams.get("token")!;
  const accepted = await acceptInvitation(user.client, token);
  if (!accepted.ok) throw new Error(accepted.error);
  return { ...user, email };
}

describe("Membership invitations", () => {
  it("lists direct and inherited Company access separately from pending invitations", async () => {
    const administrator = await administratorWithCompany();
    const directUser = await inviteAndAccept(administrator);
    const pendingEmail = uniqueEmail();
    const mail = capturingMailer();

    expect(await inviteMember(administrator.client, mail.mailer, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
      email: pendingEmail,
      role: "user",
      acceptUrl: "http://127.0.0.1:3100/invitations/accept",
    })).toEqual({ ok: true, value: null });

    const access = await listCompanyAccess(administrator.client, administrator.companyId);
    expect(access).toEqual({ ok: true, value: expect.any(Array) });
    if (!access.ok) throw new Error(access.error);
    expect(access.value).toHaveLength(2);
    expect(access.value).toEqual(expect.arrayContaining([
      expect.objectContaining({
        email: administrator.email,
        role: "administrator",
        source: "organization",
        manageableMembershipId: null,
      }),
      expect.objectContaining({
        email: directUser.email,
        role: "user",
        source: "company",
        manageableMembershipId: expect.any(String),
      }),
    ]));
    expect(await listPendingInvitations(administrator.client, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
    })).toEqual([
      expect.objectContaining({
        email: pendingEmail,
        role: "user",
        status: "pending",
        expiresAt: expect.any(String),
      }),
    ]);
  });

  it("lets an Administrator invite a User who accepts a single-use Company link", async () => {
    const administrator = await administratorWithCompany();
    const email = uniqueEmail();
    const mail = capturingMailer();

    const invited = await inviteMember(administrator.client, mail.mailer, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
      email,
      role: "user",
      acceptUrl: "http://127.0.0.1:3100/invitations/accept",
    });

    expect(invited.ok).toBe(true);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toEqual({
      email,
      acceptUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:3100\/invitations\/accept\?token=.+$/),
    });
    const token = new URL(mail.sent[0].acceptUrl).searchParams.get("token")!;
    const user = await invitedUser(email);
    expect(await listMyOrganizations(user.client)).toEqual([]);

    expect(await acceptInvitation(user.client, token)).toEqual({ ok: true, value: null });
    expect(await acceptInvitation(user.client, token)).toEqual({ ok: false, error: "invitation_used" });
    expect(await listMyCompanies(user.client)).toEqual([
      {
        id: administrator.companyId,
        organizationId: administrator.organizationId,
        name: "Novák s.r.o.",
      },
    ]);
  });

  it("refuses a User who tries to invite or manage Company members", async () => {
    const administrator = await administratorWithCompany();
    const member = await inviteAndAccept(administrator);
    const membership = (await listMemberships(administrator.client, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
    }))[0];
    const mail = capturingMailer();

    const invited = await inviteMember(member.client, mail.mailer, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
      email: uniqueEmail(),
      role: "user",
      acceptUrl: "http://127.0.0.1:3100/invitations/accept",
    });

    expect(invited).toEqual({ ok: false, error: "forbidden" });
    expect(await changeMembershipRole(member.client, { membershipId: membership.id, role: "administrator" }))
      .toEqual({ ok: false, error: "forbidden" });
    expect(await removeMembership(member.client, membership.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await listCompanyAccess(member.client, administrator.companyId))
      .toEqual({ ok: false, error: "forbidden" });
    expect(await listPendingInvitations(member.client, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
    })).toEqual([]);
    expect(mail.sent).toEqual([]);
  });

  it("refuses an invitation link used by a different signed-in email", async () => {
    const administrator = await administratorWithCompany();
    const email = uniqueEmail();
    const mail = capturingMailer();
    await inviteMember(administrator.client, mail.mailer, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
      email,
      role: "user",
      acceptUrl: "http://127.0.0.1:3100/invitations/accept",
    });
    const token = new URL(mail.sent[0].acceptUrl).searchParams.get("token")!;
    const other = await invitedUser(uniqueEmail());

    expect(await acceptInvitation(other.client, token)).toEqual({ ok: false, error: "forbidden" });
    const intended = await invitedUser(email);
    expect(await acceptInvitation(intended.client, token)).toEqual({ ok: true, value: null });
  });

  it("does not strand a person when the invitation email cannot be sent", async () => {
    const administrator = await administratorWithCompany();
    const email = uniqueEmail();
    const failingMailer: InvitationMailer = {
      async sendInvitation() {
        throw new Error("SMTP unavailable");
      },
    };

    expect(await inviteMember(administrator.client, failingMailer, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
      email,
      role: "user",
      acceptUrl: "http://127.0.0.1:3100/invitations/accept",
    })).toEqual({ ok: false, error: "invitation_failed" });

    const user = await invitedUser(email);
    expect(await listMyOrganizations(user.client)).toEqual([
      expect.objectContaining({ name: "Ignored for invited users", role: "administrator" }),
    ]);
  });

  it("applies Role changes and removals immediately and audits them", async () => {
    const administrator = await administratorWithCompany();
    const member = await inviteAndAccept(administrator);
    const [membership] = await listMemberships(administrator.client, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
    });

    expect(await changeMembershipRole(administrator.client, {
      membershipId: membership.id,
      role: "administrator",
    })).toEqual({ ok: true, value: null });
    const promotedMail = capturingMailer();
    expect(await inviteMember(member.client, promotedMail.mailer, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
      email: uniqueEmail(),
      role: "user",
      acceptUrl: "http://127.0.0.1:3100/invitations/accept",
    })).toEqual({ ok: true, value: null });

    expect(await removeMembership(administrator.client, membership.id)).toEqual({ ok: true, value: null });
    expect(await listMyCompanies(member.client)).toEqual([]);
    expect((await listAuditEvents(administrator.client, administrator.organizationId)).map((event) => event.action))
      .toEqual(expect.arrayContaining([
        "invitation.created",
        "membership.created",
        "membership.role_changed",
        "membership.removed",
      ]));
  });

  it("keeps another Organization from seeing or changing invitations and Memberships", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await administratorWithCompany("Organization B");
    const member = await inviteAndAccept(a);
    const [membership] = await listMemberships(a.client, {
      organizationId: a.organizationId,
      companyId: a.companyId,
    });
    const mail = capturingMailer();

    expect(await inviteMember(b.client, mail.mailer, {
      organizationId: a.organizationId,
      companyId: a.companyId,
      email: uniqueEmail(),
      role: "user",
      acceptUrl: "http://127.0.0.1:3100/invitations/accept",
    })).toEqual({ ok: false, error: "forbidden" });
    expect(await changeMembershipRole(b.client, { membershipId: membership.id, role: "administrator" }))
      .toEqual({ ok: false, error: "forbidden" });
    expect(await removeMembership(b.client, membership.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await listCompanyAccess(b.client, a.companyId))
      .toEqual({ ok: false, error: "forbidden" });
    expect(await listPendingInvitations(b.client, {
      organizationId: a.organizationId,
      companyId: a.companyId,
    })).toEqual([]);
    expect(await listMemberships(b.client, { organizationId: a.organizationId, companyId: a.companyId })).toEqual([]);
    expect((await b.client.from("invitation").select("id").eq("organization_id", a.organizationId)).data).toEqual([]);
    expect((await b.client.from("membership").select("id").eq("organization_id", a.organizationId)).data).toEqual([]);
    expect(await listMyCompanies(member.client)).toHaveLength(1);
  });

  it("gives Organization Administrators all Companies while a Company member sees only assigned Companies", async () => {
    const administrator = await administratorWithCompany();
    const second = await createCompany(administrator.client, {
      organizationId: administrator.organizationId,
      ...companyDetails({ name: "Druhá s.r.o." }),
    });
    if (!second.ok) throw new Error(second.error);
    const member = await inviteAndAccept(administrator);

    expect((await listMyCompanies(administrator.client)).map((company) => company.id).sort())
      .toEqual([administrator.companyId, second.value.id].sort());
    expect((await listMyCompanies(member.client)).map((company) => company.id)).toEqual([administrator.companyId]);
  });

  it("lets an Organization Administrator invite another Organization Administrator", async () => {
    const administrator = await administratorWithCompany();
    const email = uniqueEmail();
    const mail = capturingMailer();

    expect(await inviteMember(administrator.client, mail.mailer, {
      organizationId: administrator.organizationId,
      companyId: null,
      email,
      role: "administrator",
      acceptUrl: "http://127.0.0.1:3100/invitations/accept",
    })).toEqual({ ok: true, value: null });
    const invited = await invitedUser(email);
    const token = new URL(mail.sent[0].acceptUrl).searchParams.get("token")!;
    expect(await acceptInvitation(invited.client, token)).toEqual({ ok: true, value: null });

    expect(await listMyOrganizations(invited.client)).toEqual([
      { id: administrator.organizationId, name: "Test Organization", role: "administrator" },
    ]);
    expect((await listMyCompanies(invited.client)).map((company) => company.id)).toEqual([administrator.companyId]);
  });
});
