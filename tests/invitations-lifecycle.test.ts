import { listAuditEvents } from "@/application/audit";
import { totp } from "./support/totp";
import { beginTotpEnrollment, completeTotpEnrollment, mfaPolicy, mfaStatus, setOrganizationMfaRequired, verifyTotp } from "@/application/mfa";
import { describe, expect, it } from "vitest";
import { acceptInvitation, cancelInvitation, completeInvitationOnboarding, generateInvitationLink, getInvitationOnboarding, listCompanyAccess, listPendingInvitations, replaceInvitationLink } from "@/application/memberships";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { anonymousClient, provisionedAccount, provisionedUser, uniqueEmail } from "./support/clients";
import { ageInvitationFixture, invitationAuthenticationFixture, passwordlessIdentityFixture } from "./support/invitations";
import { listMyOrganizations } from "@/application/organizations";
import { listMyCompanies } from "@/application/companies";

const acceptUrl = "http://127.0.0.1:3103/invitations/accept";

async function offerFixture(email = uniqueEmail()) {
  const administrator = await administratorWithCompany();
  const scope = { organizationId: administrator.organizationId, companyId: administrator.companyId };
  const generated = await generateInvitationLink(administrator.client, { ...scope, email, role: "user", acceptUrl });
  if (!generated.ok) throw new Error(generated.error);
  const [invitation] = await listPendingInvitations(administrator.client, scope);
  return { administrator, email, scope, invitation, token: generated.value.token };
}

describe("persistent Invitations", () => {
  it("keeps the same scoped link and seven-day expiry available to an Administrator after reloading", async () => {
    const administrator = await administratorWithCompany();
    const email = uniqueEmail();
    const generated = await generateInvitationLink(administrator.client, {
      organizationId: administrator.organizationId, companyId: administrator.companyId,
      email, role: "user", acceptUrl,
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) throw new Error(generated.error);
    const scope = { organizationId: administrator.organizationId, companyId: administrator.companyId };
    const [first] = await listPendingInvitations(administrator.client, scope);
    const [reloaded] = await listPendingInvitations(administrator.client, scope);
    expect(first.email).toBe(email);
    expect(first.token).toBe(new URLSearchParams(new URL(generated.value.acceptUrl).hash.slice(1)).get("token"));
    expect(first.token).not.toBeNull();
    expect(reloaded).toEqual(first);
    expect(Date.parse(first.expiresAt) - Date.parse(first.createdAt)).toBe(604_800_000);
  });
  it("cancels an invitation authoritatively and retains a distinct cancelled state", async () => {
    const administrator = await administratorWithCompany();
    const generated = await generateInvitationLink(administrator.client, {
      organizationId: administrator.organizationId, companyId: administrator.companyId,
      email: uniqueEmail(), role: "user", acceptUrl,
    });
    if (!generated.ok) throw new Error(generated.error);
    const [invitation] = await listPendingInvitations(administrator.client, {
      organizationId: administrator.organizationId, companyId: administrator.companyId,
    });
    expect(await cancelInvitation(administrator.client, invitation.id)).toEqual({ ok: true, value: null });
    expect(await getInvitationOnboarding(administrator.client, generated.value.token)).toEqual({ status: "cancelled" });
    const [cancelled] = await listPendingInvitations(administrator.client, {
      organizationId: administrator.organizationId, companyId: administrator.companyId,
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.token).toBeNull();
  });
  it("replaces a pending link with a new seven-day capability and invalidates the old one", async () => {
    const administrator = await administratorWithCompany();
    const scope = { organizationId: administrator.organizationId, companyId: administrator.companyId };
    const first = await generateInvitationLink(administrator.client, { ...scope, email: uniqueEmail(), role: "administrator", acceptUrl });
    if (!first.ok) throw new Error(first.error);
    const [original] = await listPendingInvitations(administrator.client, scope);
    const replacement = await replaceInvitationLink(administrator.client, { invitationId: original.id, acceptUrl });
    if (!replacement.ok) throw new Error(replacement.error);
    expect(replacement.value.token).not.toBe(first.value.token);
    expect(await getInvitationOnboarding(administrator.client, first.value.token)).toEqual({ status: "replaced" });
    const invitations = await listPendingInvitations(administrator.client, scope);
    expect(invitations.find(item => item.id === original.id)).toMatchObject({ status: "replaced", token: null });
    const renewed = invitations.find(item => item.token === replacement.value.token)!;
    expect(renewed.role).toBe("administrator");
    expect(Date.parse(renewed.expiresAt) - Date.parse(renewed.createdAt)).toBe(604_800_000);
  });

  it("privately provisions a genuinely new invitee with their chosen password and no unrelated Organization", async () => {
    const administrator = await administratorWithCompany();
    const generated = await generateInvitationLink(administrator.client, {
      organizationId: administrator.organizationId, companyId: administrator.companyId,
      email: uniqueEmail(), role: "user", acceptUrl,
    });
    if (!generated.ok) throw new Error(generated.error);
    const invitee = anonymousClient();
    expect(await completeInvitationOnboarding(invitee, { token: generated.value.token, password: "chosen-password-166" }, invitationAuthenticationFixture()))
      .toEqual({ ok: true, value: { companyId: administrator.companyId } });
    expect(await listMyCompanies(invitee)).toEqual([{
      id: administrator.companyId, organizationId: administrator.organizationId, name: "Novák s.r.o.",
    }]);
  });

  it("does not let a newly provisioned pending identity bypass authoritative acceptance", async () => {
    const administrator = await administratorWithCompany();
    const generated = await generateInvitationLink(administrator.client, {
      organizationId: administrator.organizationId, companyId: administrator.companyId,
      email: uniqueEmail(), role: "user", acceptUrl,
    });
    if (!generated.ok) throw new Error(generated.error);
    const visitor = anonymousClient();
    const claim = await visitor.rpc("begin_invitation_acceptance", { invitation_token: generated.value.token });
    if (claim.error) throw claim.error;
    const authentication = invitationAuthenticationFixture();
    try {
      const authenticated = await authentication.authenticate(claim.data, "pending-password-166");
      if (!authenticated.ok) throw new Error(authenticated.error);
      expect(await listMyCompanies(authenticated.value.client)).toEqual([]);
      expect(await acceptInvitation(authenticated.value.client, generated.value.token)).toEqual({ ok: false, error: "forbidden" });
    } finally { await authentication.abort(claim.data); }
  });

  it("keeps two-day-old links usable independently of a one-hour Auth email token", async () => {
    const offer = await offerFixture();
    await ageInvitationFixture(offer.token, 2);
    const visitor = anonymousClient();
    expect(await completeInvitationOnboarding(visitor, { token: offer.token, password: "two-day-password-166" }, invitationAuthenticationFixture()))
      .toEqual({ ok: true, value: { companyId: offer.administrator.companyId } });
    expect(await listMyCompanies(visitor)).toHaveLength(1);
  });

  it("refuses seven-day-expired links without creating an Auth session", async () => {
    const offer = await offerFixture();
    await ageInvitationFixture(offer.token, 7);
    const visitor = anonymousClient();
    expect(await completeInvitationOnboarding(visitor, { token: offer.token, password: "expired-password-166" }, invitationAuthenticationFixture()))
      .toEqual({ ok: false, error: "invitation_expired" });
    expect((await visitor.auth.getUser()).data.user).toBeNull();
  });

  it("treats an existing Auth identity without Membership as existing and preserves its password", async () => {
    const offer = await offerFixture();
    const existing = await provisionedAccount({ email: offer.email, password: "original-password-166" });
    expect(await getInvitationOnboarding(anonymousClient(), offer.token)).toMatchObject({ status: "valid", existingUser: true });
    const visitor = anonymousClient();
    expect(await completeInvitationOnboarding(visitor, { token: offer.token, password: "different-password-166" }, invitationAuthenticationFixture()))
      .toEqual({ ok: false, error: "invalid_credentials" });
    expect(await completeInvitationOnboarding(visitor, { token: offer.token, password: "original-password-166" }, invitationAuthenticationFixture()))
      .toEqual({ ok: true, value: { companyId: offer.administrator.companyId } });
    expect((await visitor.auth.getUser()).data.user?.id).toBe(existing.userId);
  });

  it("does not assign an invitation password to an existing passwordless identity", async () => {
    const offer = await offerFixture();
    const identity = await passwordlessIdentityFixture(offer.email);
    const visitor = anonymousClient();
    expect(await getInvitationOnboarding(visitor, offer.token)).toMatchObject({ status: "valid", existingUser: true });
    expect(await completeInvitationOnboarding(visitor, { token: offer.token, password: "not-a-new-password-166" }, invitationAuthenticationFixture()))
      .toEqual({ ok: false, error: "invalid_credentials" });
    expect((await visitor.auth.getUser()).data.user).toBeNull();
    await identity.authenticate(visitor);
    expect(await completeInvitationOnboarding(visitor, { token: offer.token, password: "" }, invitationAuthenticationFixture()))
      .toEqual({ ok: true, value: { companyId: offer.administrator.companyId } });
    expect(await listMyCompanies(visitor)).toHaveLength(1);
    expect((await anonymousClient().auth.signInWithPassword({ email: offer.email, password: "not-a-new-password-166" })).error).not.toBeNull();
  });

  it("refuses another Organization and regular User direct access to invitation links and privileged claims", async () => {
    const offer = await offerFixture();
    const outsider = await administratorWithCompany();
    const regular = await companyMember(offer.administrator);
    for (const actor of [outsider, regular]) {
      expect(await listPendingInvitations(actor.client, offer.scope)).toEqual([]);
      expect(await cancelInvitation(actor.client, offer.invitation.id)).toEqual({ ok: false, error: "forbidden" });
      expect(await replaceInvitationLink(actor.client, { invitationId: offer.invitation.id, acceptUrl })).toEqual({ ok: false, error: "forbidden" });
      expect((await actor.client.from("invitation").select("id, token_secret_id").eq("id", offer.invitation.id)).data).toEqual([]);
      expect((await actor.client.rpc("invitation_authentication_authority", { acceptance_claim_id: offer.invitation.id })).error?.code).toBe("42501");
    }
  });

  it("does not create an identity when cancellation wins after authority was issued but before native Auth inserts", async () => {
    const offer = await offerFixture();
    const visitor = anonymousClient();
    const authentication = invitationAuthenticationFixture(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/auth/v1/admin/users") && init?.method === "POST") {
        expect(await cancelInvitation(offer.administrator.client, offer.invitation.id)).toEqual({ ok: true, value: null });
      }
      return fetch(input, init);
    });
    expect(await completeInvitationOnboarding(visitor, { token: offer.token, password: "cancelled-password-166" }, authentication))
      .toEqual({ ok: false, error: "invitation_cancelled" });
    expect((await visitor.auth.getUser()).data.user).toBeNull();
    const fresh = await generateInvitationLink(offer.administrator.client, { ...offer.scope, email: offer.email, role: "user", acceptUrl });
    if (!fresh.ok) throw new Error(fresh.error);
    expect(await getInvitationOnboarding(visitor, fresh.value.token)).toMatchObject({ status: "valid", existingUser: false });
  });

  it("cleans up only its newly provisioned orphan when cancellation wins before Membership acceptance", async () => {
    const offer = await offerFixture();
    const visitor = anonymousClient();
    const real = invitationAuthenticationFixture();
    const authentication = {
      ...real,
      async authenticate(claim: string, password: string) {
        const result = await real.authenticate(claim, password);
        expect(result.ok).toBe(true);
        expect(await cancelInvitation(offer.administrator.client, offer.invitation.id)).toEqual({ ok: true, value: null });
        return result;
      },
    };
    expect(await completeInvitationOnboarding(visitor, { token: offer.token, password: "orphan-password-166" }, authentication))
      .toEqual({ ok: false, error: "invitation_cancelled" });
    expect((await visitor.auth.getUser()).data.user).toBeNull();
    const fresh = await generateInvitationLink(offer.administrator.client, { ...offer.scope, email: offer.email, role: "user", acceptUrl });
    if (!fresh.ok) throw new Error(fresh.error);
    expect(await getInvitationOnboarding(visitor, fresh.value.token)).toMatchObject({ status: "valid", existingUser: false });
  });

  it("does not overwrite an identity created concurrently after the new-user claim", async () => {
    const offer = await offerFixture();
    const visitor = anonymousClient();
    const authentication = invitationAuthenticationFixture(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/auth/v1/admin/users") && init?.method === "POST") {
        await provisionedAccount({ email: offer.email, password: "concurrent-original-166" });
      }
      return fetch(input, init);
    });
    expect(await completeInvitationOnboarding(visitor, { token: offer.token, password: "concurrent-invited-166" }, authentication))
      .toEqual({ ok: false, error: "invitation_identity_changed" });
    expect((await visitor.auth.getUser()).data.user).toBeNull();
    expect((await visitor.auth.signInWithPassword({ email: offer.email, password: "concurrent-original-166" })).error).toBeNull();
    expect(await listMyCompanies(visitor)).toEqual([]);
  });

  it("serializes simultaneous acceptance without duplicate Memberships or a session for the loser", async () => {
    const offer = await offerFixture();
    const visitors = [anonymousClient(), anonymousClient()];
    const results = await Promise.all(visitors.map(client => completeInvitationOnboarding(client, {
      token: offer.token, password: "simultaneous-password-166",
    }, invitationAuthenticationFixture())));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    const loser = results.findIndex(result => !result.ok);
    expect((await visitors[loser].auth.getUser()).data.user).toBeNull();
    const access = await listCompanyAccess(offer.administrator.client, offer.administrator.companyId);
    if (!access.ok) throw new Error(access.error);
    expect(access.value.filter(member => member.email === offer.email)).toHaveLength(1);
  });

  it("serializes replacement against acceptance of the old link", async () => {
    const offer = await offerFixture();
    const user = await provisionedAccount({ email: offer.email, password: "replace-race-password-166" });
    const [accepted, replaced] = await Promise.all([
      acceptInvitation(user.client, offer.token),
      replaceInvitationLink(offer.administrator.client, { invitationId: offer.invitation.id, acceptUrl }),
    ]);
    expect([accepted.ok, replaced.ok].filter(Boolean)).toHaveLength(1);
    if (accepted.ok) {
      expect(replaced).toEqual({ ok: false, error: "invitation_used" });
      expect(await listMyCompanies(user.client)).toHaveLength(1);
    } else {
      expect(accepted).toEqual({ ok: false, error: "invitation_replaced" });
      expect(await listMyCompanies(user.client)).toEqual([]);
    }
  });

  it("cancellation itself removes its unaccepted newly provisioned identity even if the accepting request never finishes", async () => {
    const offer = await offerFixture();
    const visitor = anonymousClient();
    const claimed = await visitor.rpc("begin_invitation_acceptance", { invitation_token: offer.token });
    if (claimed.error) throw claimed.error;
    const authentication = invitationAuthenticationFixture();
    try {
      const signedIn = await authentication.authenticate(claimed.data, "interrupted-password-166");
      if (!signedIn.ok) throw new Error(signedIn.error);
      expect(await cancelInvitation(offer.administrator.client, offer.invitation.id)).toEqual({ ok: true, value: null });
      const fresh = await generateInvitationLink(offer.administrator.client, { ...offer.scope, email: offer.email, role: "user", acceptUrl });
      if (!fresh.ok) throw new Error(fresh.error);
      expect(await getInvitationOnboarding(visitor, fresh.value.token)).toMatchObject({ status: "valid", existingUser: false });
    } finally { await authentication.abort(claimed.data); }
  });

  it("requires an existing authenticator after password acceptance and preserves an already elevated session", async () => {
    const offer = await offerFixture();
    const existing = await provisionedAccount({ email: offer.email, password: "mfa-invitation-password-166" });
    const enrollment = await beginTotpEnrollment(existing.client);
    if (!enrollment.ok) throw new Error(enrollment.error);
    const completed = await completeTotpEnrollment(existing.client, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) });
    if (!completed.ok) throw new Error(completed.error);
    await existing.client.auth.signOut();
    const visitor = anonymousClient();
    expect(await completeInvitationOnboarding(visitor, { token: offer.token, password: "mfa-invitation-password-166" }, invitationAuthenticationFixture()))
      .toEqual({ ok: true, value: { companyId: offer.administrator.companyId } });
    expect(await mfaPolicy(visitor)).toEqual({ required: false, enrolled: true, satisfied: false });
    expect(await listMyCompanies(visitor)).toEqual([]);
    expect(await verifyTotp(visitor, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) })).toEqual({ ok: true, value: null });
    expect(await listMyCompanies(visitor)).toHaveLength(1);
    const again = await generateInvitationLink(offer.administrator.client, { ...offer.scope, email: offer.email, role: "administrator", acceptUrl });
    if (!again.ok) throw new Error(again.error);
    const before = (await visitor.auth.getSession()).data.session?.access_token;
    expect(await completeInvitationOnboarding(visitor, { token: again.value.token, password: "" }, invitationAuthenticationFixture()))
      .toEqual({ ok: true, value: { companyId: offer.administrator.companyId } });
    expect((await visitor.auth.getSession()).data.session?.access_token).toBe(before);
    expect((await mfaStatus(visitor)).currentLevel).toBe("aal2");
  });

  it("never removes a preexisting identity or its other Organization when a late acceptance is cancelled", async () => {
    const existing = await provisionedUser("Existing Organization");
    const offer = await offerFixture(existing.email);
    const real = invitationAuthenticationFixture();
    const visitor = anonymousClient();
    const authentication = { ...real, async authenticate(claim: string, password: string) {
      const result = await real.authenticate(claim, password);
      expect(await cancelInvitation(offer.administrator.client, offer.invitation.id)).toEqual({ ok: true, value: null });
      return result;
    } };
    expect(await completeInvitationOnboarding(visitor, { token: offer.token, password: "correct-horse-battery" }, authentication))
      .toEqual({ ok: false, error: "invitation_cancelled" });
    expect((await visitor.auth.getUser()).data.user).toBeNull();
    expect((await existing.client.auth.getUser()).data.user?.id).toBe(existing.userId);
    expect(await listMyCompanies(existing.client)).toEqual([]);
    expect(await listMyOrganizations(existing.client)).toEqual([{ id: existing.organizationId, name: "Existing Organization", role: "administrator" }]);
  });

  it("enforces Organization MFA for a newly invited Administrator before data or policy changes", async () => {
    const administrator = await administratorWithCompany();
    const generated = await generateInvitationLink(administrator.client, {
      organizationId: administrator.organizationId, companyId: null, email: uniqueEmail(), role: "administrator", acceptUrl,
    });
    if (!generated.ok) throw new Error(generated.error);
    expect(await setOrganizationMfaRequired(administrator.client, { organizationId: administrator.organizationId, required: true })).toEqual({ ok: true, value: null });
    const visitor = anonymousClient();
    expect(await completeInvitationOnboarding(visitor, { token: generated.value.token, password: "mandatory-mfa-166" }, invitationAuthenticationFixture()))
      .toEqual({ ok: true, value: { companyId: null } });
    expect(await mfaPolicy(visitor)).toEqual({ required: true, enrolled: false, satisfied: false });
    expect(await listMyCompanies(visitor)).toEqual([]);
    expect(await setOrganizationMfaRequired(visitor, { organizationId: administrator.organizationId, required: false })).toEqual({ ok: false, error: "forbidden" });
    const enrollment = await beginTotpEnrollment(visitor);
    if (!enrollment.ok) throw new Error(enrollment.error);
    expect((await completeTotpEnrollment(visitor, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) })).ok).toBe(true);
    expect(await listMyCompanies(visitor)).toHaveLength(1);
  });

  it("keeps private acceptance claims inaccessible through another Organization's direct API queries", async () => {
    const offer = await offerFixture();
    const visitor = anonymousClient();
    const claimed = await visitor.rpc("begin_invitation_acceptance", { invitation_token: offer.token });
    if (claimed.error) throw claimed.error;
    const outsider = await administratorWithCompany();
    try {
      // Private schemas intentionally are not exposed by PostgREST. Casts only
      // let this adversarial test ask for the otherwise unrepresentable table.
      const direct = outsider.client.schema("private" as "public").from("invitation_acceptance_claim" as "invitation");
      expect((await direct.select("id").eq("id", claimed.data)).error?.code).toBe("PGRST106");
      expect((await outsider.client.schema("private" as "public").from("invitation_acceptance_claim" as "invitation").delete().eq("id", claimed.data)).error?.code).toBe("PGRST106");
      expect((await outsider.client.rpc("complete_invitation_acceptance", { acceptance_claim_id: claimed.data })).error?.code).toBe("42501");
    } finally { await invitationAuthenticationFixture().abort(claimed.data); }
  });

  it("attributes acceptance to the real User while audit payloads omit email, password and capabilities", async () => {
    const offer = await offerFixture();
    const visitor = anonymousClient();
    expect((await completeInvitationOnboarding(visitor, { token: offer.token, password: "audit-password-166" }, invitationAuthenticationFixture())).ok).toBe(true);
    const userId = (await visitor.auth.getUser()).data.user!.id;
    const events = await listAuditEvents(offer.administrator.client, offer.administrator.organizationId);
    expect(events.find(event => event.action === "membership.created")).toMatchObject({ actorUserId: userId });
    const payloads = JSON.stringify(events.map(event => event.payload));
    for (const secret of [offer.email, offer.token, "audit-password-166"]) expect(payloads).not.toContain(secret);
  });

});
