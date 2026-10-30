import { invitationAuthenticationFixture } from "./support/invitations";
import { withPostgrestRowLimit } from "./support/postgrest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, inject, it } from "vitest";
import { listAuditEvents } from "@/application/audit";
import {
  acceptInvitation,
  changeMembershipRole,
  completeInvitationOnboarding,
  getInvitationOnboarding,
  inviteMember,
  listCompanyAccess,
  listMemberships,
  listPendingInvitations,
  removeMembership,
  type InvitationMailer,
} from "@/application/memberships";
import { listMyCompanies } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { anonymousClient, provisionedAccount, uniqueEmail } from "./support/clients";
import { administratorWithCompany, companyDetails } from "./support/fixtures";
import { createCompany } from "@/application/companies";
import type { Database } from "@/lib/database.types";

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
  return provisionedAccount({
    email,
    password: "correct-horse-battery",
    organizationName: "Ignored for invited users",
  });
}

async function expireInvitation(token: string) {
  const { Client } = createRequire(import.meta.url)("pg") as {
    Client: new (input: { connectionString: string }) => {
      connect(): Promise<void>;
      end(): Promise<void>;
      query(sql: string, values: unknown[]): Promise<unknown>;
    };
  };
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query(
      "update public.invitation set expires_at = '2020-01-01T00:00:00.000Z' where token_hash = $1",
      [createHash("sha256").update(token).digest("hex")],
    );
  } finally {
    await database.end();
  }
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
  const token = new URLSearchParams(new URL(mail.sent[0].acceptUrl).hash.slice(1)).get("token")!;
  const accepted = await acceptInvitation(user.client, token);
  if (!accepted.ok) throw new Error(accepted.error);
  return { ...user, email };
}

describe("Membership invitations", () => {
  it("lets a new User set an eight-character password, accept the Membership and enter the target Company", async () => {
    const administrator = await administratorWithCompany();
    const email = uniqueEmail();
    const mail = capturingMailer();
    expect(await inviteMember(administrator.client, mail.mailer, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
      email,
      role: "user",
      acceptUrl: "http://127.0.0.1:3100/invitations/accept",
    })).toEqual({ ok: true, value: null });
    const token = new URLSearchParams(new URL(mail.sent[0].acceptUrl).hash.slice(1)).get("token")!;

    expect(await getInvitationOnboarding(anonymousClient(), token)).toEqual({
      status: "valid",
      email,
      existingUser: false,
      companyId: administrator.companyId,
    });

    const invitee = anonymousClient();

    expect(await completeInvitationOnboarding(invitee, { token, password: "1234567" }, invitationAuthenticationFixture()))
      .toEqual({ ok: false, error: "weak_password" });
    expect(await completeInvitationOnboarding(invitee, { token, password: "12345678" }, invitationAuthenticationFixture()))
      .toEqual({ ok: true, value: { companyId: administrator.companyId } });
    expect(await listMyCompanies(invitee)).toEqual([{
      id: administrator.companyId,
      organizationId: administrator.organizationId,
      name: "Novák s.r.o.",
    }]);

    await invitee.auth.signOut();
    expect((await invitee.auth.signInWithPassword({ email, password: "12345678" })).error).toBeNull();
  });

  it("requires an existing User's credentials without replacing their password", async () => {
    const administrator = await administratorWithCompany();
    const existing = await invitedUser(uniqueEmail());
    const { data: identity } = await existing.client.auth.getUser();
    const email = identity.user?.email;
    if (!email) throw new Error("Existing User has no email");
    const mail = capturingMailer();
    expect(await inviteMember(administrator.client, mail.mailer, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
      email,
      role: "user",
      acceptUrl: "http://127.0.0.1:3100/invitations/accept",
    })).toEqual({ ok: true, value: null });
    const token = new URLSearchParams(new URL(mail.sent[0].acceptUrl).hash.slice(1)).get("token")!;
    const invitee = anonymousClient();

    expect(await getInvitationOnboarding(invitee, token)).toEqual({
      status: "valid",
      email,
      existingUser: true,
      companyId: administrator.companyId,
    });
    expect(await completeInvitationOnboarding(invitee, { token, password: "wrong-password" }, invitationAuthenticationFixture()))
      .toEqual({ ok: false, error: "invalid_credentials" });
    expect(await completeInvitationOnboarding(invitee, { token, password: "correct-horse-battery" }, invitationAuthenticationFixture()))
      .toEqual({ ok: true, value: { companyId: administrator.companyId } });

    await invitee.auth.signOut();
    expect((await invitee.auth.signInWithPassword({ email, password: "correct-horse-battery" })).error).toBeNull();
  });

  it("lets a new invitee choose a password when an expired invitation is sent again", async () => {
    const administrator = await administratorWithCompany();
    const email = uniqueEmail();
    const firstMail = capturingMailer();
    expect(await inviteMember(administrator.client, firstMail.mailer, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
      email,
      role: "user",
      acceptUrl: "http://127.0.0.1:3100/invitations/accept",
    })).toEqual({ ok: true, value: null });
    const firstToken = new URLSearchParams(new URL(firstMail.sent[0].acceptUrl).hash.slice(1)).get("token")!;

    await expireInvitation(firstToken);
    expect(await getInvitationOnboarding(anonymousClient(), firstToken)).toEqual({ status: "expired" });

    const secondMail = capturingMailer();
    expect(await inviteMember(administrator.client, secondMail.mailer, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
      email,
      role: "user",
      acceptUrl: "http://127.0.0.1:3100/invitations/accept",
    })).toEqual({ ok: true, value: null });
    const token = new URLSearchParams(new URL(secondMail.sent[0].acceptUrl).hash.slice(1)).get("token")!;
    expect(await getInvitationOnboarding(anonymousClient(), token)).toEqual({
      status: "valid",
      email,
      existingUser: false,
      companyId: administrator.companyId,
    });

    const invitee = anonymousClient();
    expect(await completeInvitationOnboarding(invitee, { token, password: "87654321" }, invitationAuthenticationFixture()))
      .toEqual({ ok: true, value: { companyId: administrator.companyId } });
    await invitee.auth.signOut();
    expect((await invitee.auth.signInWithPassword({ email, password: "87654321" })).error).toBeNull();
  });

  it("reports invalid, used and expired invitation links through the onboarding interface", async () => {
    expect(await getInvitationOnboarding(anonymousClient(), "not-an-invitation"))
      .toEqual({ status: "invalid" });

    const administrator = await administratorWithCompany();
    const usedEmail = uniqueEmail();
    const usedMail = capturingMailer();
    expect(await inviteMember(administrator.client, usedMail.mailer, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
      email: usedEmail,
      role: "user",
      acceptUrl: "http://127.0.0.1:3100/invitations/accept",
    })).toEqual({ ok: true, value: null });
    const usedToken = new URLSearchParams(new URL(usedMail.sent[0].acceptUrl).hash.slice(1)).get("token")!;
    const usedUser = await invitedUser(usedEmail);
    expect(await acceptInvitation(usedUser.client, usedToken)).toEqual({ ok: true, value: null });
    expect(await getInvitationOnboarding(anonymousClient(), usedToken)).toEqual({ status: "used" });

    const expiredEmail = uniqueEmail();
    const expiredMail = capturingMailer();
    expect(await inviteMember(administrator.client, expiredMail.mailer, {
      organizationId: administrator.organizationId,
      companyId: administrator.companyId,
      email: expiredEmail,
      role: "user",
      acceptUrl: "http://127.0.0.1:3100/invitations/accept",
    })).toEqual({ ok: true, value: null });
    const expiredToken = new URLSearchParams(new URL(expiredMail.sent[0].acceptUrl).hash.slice(1)).get("token")!;
    await expireInvitation(expiredToken);
    expect(await getInvitationOnboarding(anonymousClient(), expiredToken)).toEqual({ status: "expired" });
  });

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

  it("lists every effective User when Company access exceeds the PostgREST row limit", async () => {
    const administrator = await administratorWithCompany();
    const service = createClient<Database>(inject("supabaseUrl"), inject("supabaseSecretKey"), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const directUserCount = 21;
    const users: { email: string; id: string }[] = [];

    for (let offset = 0; offset < directUserCount; offset += 50) {
      const created = await Promise.all(Array.from({ length: Math.min(50, directUserCount - offset) }, async (_, index) => {
        const email = `access-page-${offset + index}-${crypto.randomUUID()}@example.test`;
        const { data, error } = await service.auth.admin.createUser({
          email,
          email_confirm: true,
          password: "correct-horse-battery",
          user_metadata: { organization_name: `Access page ${offset + index}` },
        });
        if (error) throw error;
        return { email, id: data.user.id };
      }));
      users.push(...created);
    }

    for (let offset = 0; offset < users.length; offset += 500) {
      const { error } = await service.from("membership").insert(users.slice(offset, offset + 500).map((user) => ({
        company_id: administrator.companyId,
        email: user.email,
        organization_id: administrator.organizationId,
        role: "user" as const,
        user_id: user.id,
      })));
      if (error) throw error;
    }

    try {
      await withPostgrestRowLimit(20,
        () => administrator.client.from("membership").select("id").eq("company_id", administrator.companyId),
        async () => {
          const access = await listCompanyAccess(administrator.client, administrator.companyId);
          expect(access).toEqual({ ok: true, value: expect.any(Array) });
          if (!access.ok) throw new Error(access.error);
          expect(access.value).toHaveLength(22);
          expect(new Set(access.value.map((entry) => entry.userId)).size).toBe(22);
        },
      );
    } finally {
      const organizations = await service.from("membership").select("organization_id")
        .in("user_id", users.map(user => user.id)).is("company_id", null);
      if (organizations.error) throw organizations.error;
      for (const user of users) {
        const removed = await service.auth.admin.deleteUser(user.id);
        if (removed.error) throw removed.error;
      }
      const deleted = await service.from("organization").delete()
        .in("id", organizations.data.map(entry => entry.organization_id));
      if (deleted.error) throw deleted.error;
    }
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
      acceptUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:3100\/invitations\/accept#token=.+$/),
    });
    const token = new URLSearchParams(new URL(mail.sent[0].acceptUrl).hash.slice(1)).get("token")!;
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
    const token = new URLSearchParams(new URL(mail.sent[0].acceptUrl).hash.slice(1)).get("token")!;
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
    const token = new URLSearchParams(new URL(mail.sent[0].acceptUrl).hash.slice(1)).get("token")!;
    expect(await acceptInvitation(invited.client, token)).toEqual({ ok: true, value: null });

    expect(await listMyOrganizations(invited.client)).toEqual([
      { id: administrator.organizationId, name: "Test Organization", role: "administrator" },
    ]);
    expect((await listMyCompanies(invited.client)).map((company) => company.id)).toEqual([administrator.companyId]);
  });
});
