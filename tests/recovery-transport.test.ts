import { beginTotpEnrollment, completeTotpEnrollment } from "@/application/mfa";
import { beginBackupRecovery, finishBackupRecovery, mfaReplacementStatus, startReplacementEnrollment, verifyReplacementAuthenticator } from "@/application/mfa-replacement";
import { supabaseMfaReplacementAuthentication } from "@/auth/supabase-mfa-replacement";
import { totp } from "./support/totp";
import { succeeded } from "./support/results";
import { supabaseInvitationAuthentication } from "@/auth/supabase-invitation-authentication";
import { completeInvitationOnboarding, generateInvitationLink, getInvitationOnboarding } from "@/application/memberships";
import { listMyOrganizations } from "@/application/organizations";
import { describe, expect, inject, it } from "vitest";
import { anonymousClient, provisionedUser, uniqueEmail } from "./support/clients";
import { recoverPassword, recoveryLinkStatus, recoveryStatus, requestPasswordRecovery, verifyPasswordRecovery } from "@/application/password-recovery";
import { supabasePasswordRecovery } from "@/auth/supabase-password-recovery";
import { createSupabaseTransport } from "@/lib/supabase/transport";
import { createClient } from "@supabase/supabase-js";
import { asUserClient } from "@/application/client";
import { recoveryEmailFixture } from "./support/password-recovery";
import { supabaseHttpGateway } from "./support/supabase-http-gateway";

describe("recovery over internal Auth transport", () => {
  it("reports an unavailable request capability dependency for known and unknown addresses", async () => {
    const user = await provisionedUser();
    const gateway = await supabaseHttpGateway(inject("supabaseUrl"));
    try {
      gateway.unavailable(true, "/rest/v1/rpc/create_password_recovery_request");
      const publicUrl = inject("supabaseUrl").replace("http:", "https:");
      const authentication = supabasePasswordRecovery({
        url: publicUrl, publishableKey: inject("supabaseAnonKey"), secretKey: inject("supabaseSecretKey"),
        resetUrl: "http://127.0.0.1:3103/password/reset",
        fetch: createSupabaseTransport({ publicUrl, internalUrl: gateway.url }),
      });
      for (const path of ["/rest/v1/rpc/create_password_recovery_request", "/"]) {
        gateway.unavailable(true, path);
        for (const email of [user.email, "unknown-transport@example.test"]) {
          expect(await requestPasswordRecovery(anonymousClient(), authentication, email))
            .toEqual({ ok: false, error: "auth_unavailable" });
        }
      }
    } finally { gateway.close(); }
  });
  it("returns dependency Results for recovery status, capability lookup and MFA transition RPC outages without deleting the native session", async () => {
    const user = await provisionedUser();
    const gateway = await supabaseHttpGateway(inject("supabaseUrl"));
    try {
      const publicUrl = inject("supabaseUrl").replace("http:", "https:");
      const transport = createSupabaseTransport({ publicUrl, internalUrl: gateway.url });
      const visitor = asUserClient(createClient(publicUrl, inject("supabaseAnonKey"), {
        auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport },
      }));
      await visitor.auth.setSession((await user.client.auth.getSession()).data.session!);
      const before = (await visitor.auth.getClaims()).data?.claims.session_id;
      const authentication = supabaseMfaReplacementAuthentication({ url: publicUrl, publishableKey: inject("supabaseAnonKey"), secretKey: inject("supabaseSecretKey"), fetch: transport });
      const queries = [
        ["/rest/v1/rpc/password_recovery_link_status", () => recoveryLinkStatus(visitor, "invalid")],
        ["/rest/v1/rpc/password_recovery_status", () => recoveryStatus(visitor)],
        ["/rest/v1/rpc/mfa_replacement_status", () => mfaReplacementStatus(visitor)],
        ["/rest/v1/rpc/invitation_onboarding", () => getInvitationOnboarding(visitor, "invalid")],
        ["/rest/v1/rpc/begin_mfa_replacement", () => beginBackupRecovery(visitor, { code: "invalid" })],
        ["/rest/v1/rpc/claim_mfa_replacement_operation", () => startReplacementEnrollment(visitor, authentication)],
        ["/rest/v1/rpc/claim_password_recovery", () => recoverPassword(visitor, { newPassword: "Transport-password", confirmation: "Transport-password" })],
      ] as const;
      for (const [path, query] of queries) {
        gateway.unavailable(true, path);
        expect(await query()).toEqual({ ok: false, error: "auth_unavailable" });
      }
      gateway.unavailable(true, "/auth/v1/user");
      expect(await recoveryStatus(visitor)).toEqual({ ok: false, error: "auth_unavailable" });
      expect(await mfaReplacementStatus(visitor)).toEqual({ ok: false, error: "auth_unavailable" });
      gateway.unavailable(false);
      expect((await visitor.auth.refreshSession()).error).toBeNull();
      expect((await visitor.auth.getClaims()).data?.claims.session_id).toBe(before);
    } finally { gateway.close(); }
  });

  it("keeps native recover-only outages, mail and rate-limit refusals private", async () => {
    const user = await provisionedUser();
    for (const refusal of [
      { status: 500, body: { code: 500, error_code: "unexpected_failure", msg: "Error sending recovery email" }, expected: { ok: true, value: null } },
      { status: 429, body: { error_code: "over_email_send_rate_limit" }, expected: { ok: true, value: null } },
      { status: 503, body: { message: "Dependency unavailable" }, expected: { ok: true, value: null } },
    ]) {
      const authentication = supabasePasswordRecovery({
        url: inject("supabaseUrl"), publishableKey: inject("supabaseAnonKey"), secretKey: inject("supabaseSecretKey"),
        resetUrl: "http://127.0.0.1:3103/password/reset", fetch: async (input, init) => {
          if (String(input).includes("/auth/v1/recover")) return Response.json(refusal.body, { status: refusal.status });
          return fetch(input, init);
        },
      });
      for (const email of [user.email, uniqueEmail()]) {
        expect(await requestPasswordRecovery(anonymousClient(), authentication, email)).toEqual(refusal.expected);
      }
    }
  });

  it("retains native email binding and the recovery session through a verification outage, then resets over private transport", async () => {
    const user = await provisionedUser();
    const gateway = await supabaseHttpGateway(inject("supabaseUrl"));
    try {
      const publicUrl = inject("supabaseUrl").replace("http:", "https:");
      await expect(fetch(`${publicUrl}/auth/v1/settings`)).rejects.toThrow();
      const transport = createSupabaseTransport({ publicUrl, internalUrl: gateway.url });
      const authentication = supabasePasswordRecovery({
        url: publicUrl, publishableKey: inject("supabaseAnonKey"), secretKey: inject("supabaseSecretKey"),
        resetUrl: "http://127.0.0.1:3103/password/reset", fetch: transport,
      });
      const visitor = asUserClient(createClient(publicUrl, inject("supabaseAnonKey"), {
        auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport },
      }));
      expect(await requestPasswordRecovery(visitor, authentication, user.email)).toEqual({ ok: true, value: null });
      const mail = await recoveryEmailFixture(user.email);
      expect(mail.url.origin).toBe("http://127.0.0.1:3103");
      expect(mail.url.toString()).not.toContain(gateway.url);
      gateway.unavailable(true, "/auth/v1/verify");
      expect(await verifyPasswordRecovery(visitor, authentication, mail)).toEqual({ ok: false, error: "auth_unavailable" });
      gateway.unavailable(false);
      expect(await verifyPasswordRecovery(visitor, authentication, mail)).toEqual({ ok: true, value: null });
      const sessionId = (await visitor.auth.getClaims()).data?.claims.session_id;
      expect(await recoverPassword(visitor, { newPassword: "Transport-recovered-password", confirmation: "Transport-recovered-password" }))
        .toEqual({ ok: true, value: null });
      expect((await visitor.auth.refreshSession()).error).toBeNull();
      expect((await visitor.auth.getClaims()).data?.claims.session_id).toBe(sessionId);
      expect(await recoveryStatus(visitor)).toEqual({ ok: true, value: "complete" });
      expect((await user.client.auth.refreshSession()).error).not.toBeNull();
    } finally { gateway.close(); }
  });
  it("onboards new and existing identities using narrow Invitation claims despite broken public TLS, and refuses a temporary password-sign-in outage truthfully", async () => {
    const administrator = await provisionedUser();
    const gateway = await supabaseHttpGateway(inject("supabaseUrl"));
    try {
      const publicUrl = inject("supabaseUrl").replace("http:", "https:");
      const transport = createSupabaseTransport({ publicUrl, internalUrl: gateway.url });
      const authentication = supabaseInvitationAuthentication({
        url: publicUrl, publishableKey: inject("supabaseAnonKey"), secretKey: inject("supabaseSecretKey"), fetch: transport,
      });
      const existing = await provisionedUser();
      for (const email of [uniqueEmail(), existing.email]) {
        const offer = succeeded(await generateInvitationLink(administrator.client, { organizationId: administrator.organizationId,
          companyId: null, email, role: "administrator", acceptUrl: "http://127.0.0.1:3103/invitations/accept" }));
        const visitor = asUserClient(createClient(publicUrl, inject("supabaseAnonKey"), {
          auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport },
        }));
        gateway.unavailable(true, "/auth/v1/token");
        expect(await completeInvitationOnboarding(visitor, { token: offer.token, password: "correct-horse-battery" }, authentication))
          .toEqual({ ok: false, error: "auth_unavailable" });
        expect((await visitor.auth.getSession()).data.session).toBeNull();
        gateway.unavailable(false);
        expect(succeeded(await getInvitationOnboarding(visitor, offer.token)).status).toBe("valid");
        expect(await completeInvitationOnboarding(visitor, { token: offer.token, password: "correct-horse-battery" }, authentication))
          .toEqual({ ok: true, value: { companyId: null } });
        expect(await listMyOrganizations(visitor)).toContainEqual(expect.objectContaining({ id: administrator.organizationId }));
        expect(succeeded(await getInvitationOnboarding(visitor, offer.token)).status).toBe("used");
        expect(offer.acceptUrl.startsWith("http://127.0.0.1:3103/invitations/accept#token=")).toBe(true);
      }
    } finally { gateway.close(); }
  });
  it("replaces a real native factor under recovery restrictions, preserving the session and password after private logout unavailability", async () => {
    const user = await provisionedUser();
    const old = succeeded(await beginTotpEnrollment(user.client));
    const codes = succeeded(await completeTotpEnrollment(user.client, { factorId: old.factorId, code: totp(old.secret) })).recoveryCodes;
    const gateway = await supabaseHttpGateway(inject("supabaseUrl"));
    try {
      const publicUrl = "https://recovery-auth.invalid";
      await expect(fetch(`${publicUrl}/auth/v1/settings`)).rejects.toThrow();
      const transport = createSupabaseTransport({ publicUrl, internalUrl: gateway.url });
      const configuration = { url: publicUrl, publishableKey: inject("supabaseAnonKey"), secretKey: inject("supabaseSecretKey"), fetch: transport };
      const authentication = supabasePasswordRecovery({ ...configuration, resetUrl: "http://127.0.0.1:3103/password/reset" });
      const replacement = supabaseMfaReplacementAuthentication(configuration);
      const visitor = asUserClient(createClient(publicUrl, inject("supabaseAnonKey"), {
        auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport },
      }));
      expect((await requestPasswordRecovery(visitor, authentication, user.email)).ok).toBe(true);
      expect((await verifyPasswordRecovery(visitor, authentication, await recoveryEmailFixture(user.email))).ok).toBe(true);
      expect((await beginBackupRecovery(visitor, { code: codes[0] })).ok).toBe(true);
      expect(await listMyOrganizations(visitor)).toEqual([]);
      gateway.unavailable(true, "/auth/v1/admin/users/");
      expect(await startReplacementEnrollment(visitor, replacement)).toEqual({ ok: false, error: "auth_unavailable" });
      gateway.unavailable(false);
      const enrolled = succeeded(await startReplacementEnrollment(visitor, replacement));
      gateway.unavailable(true, `/auth/v1/factors/${enrolled.factorId}/challenge`);
      expect(await verifyReplacementAuthenticator(visitor, totp(enrolled.secret))).toEqual({ ok: false, error: "auth_unavailable" });
      gateway.unavailable(false);
      expect(await verifyReplacementAuthenticator(visitor, totp(enrolled.secret))).toEqual({ ok: true, value: null });
      const sessionId = (await visitor.auth.getClaims()).data?.claims.session_id;
      gateway.unavailable(true, "/auth/v1/logout");
      expect(await finishBackupRecovery(visitor, replacement, { newPassword: "Mfa-transport-password", confirmation: "Mfa-transport-password" }))
        .toEqual({ ok: false, error: "auth_unavailable" });
      expect(succeeded(await mfaReplacementStatus(visitor))).toMatchObject({ pending: true, passwordUpdated: true, completionReady: false });
      expect(await listMyOrganizations(visitor)).toEqual([]);
      expect((await visitor.auth.refreshSession()).error).toBeNull();
      expect((await visitor.auth.getClaims()).data?.claims.session_id).toBe(sessionId);
      gateway.unavailable(false);
      expect(await finishBackupRecovery(visitor, replacement, { newPassword: "", confirmation: "" })).toEqual({ ok: true, value: null });
      expect(succeeded(await mfaReplacementStatus(visitor))).toMatchObject({ pending: false, accessAllowed: true });
      expect(await listMyOrganizations(visitor)).toHaveLength(1);
      expect((await user.client.auth.refreshSession()).error).not.toBeNull();
    } finally { gateway.close(); }
  });
});
