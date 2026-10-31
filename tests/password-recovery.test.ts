import { describe, expect, it } from "vitest";
import { recoverPassword, recoveryLinkStatus, recoveryStatus, requestPasswordRecovery, verifyPasswordRecovery } from "@/application/password-recovery";
import { anonymousClient, provisionedUser, uniqueEmail } from "./support/clients";
import { ageNativeRecoveryFixture, expireRecoveryRequestFixture, magicLinkSessionFixture, passwordRecoveryAuthenticationFixture, recoveryEmailFixture } from "./support/password-recovery";
import { beginTotpEnrollment, completeTotpEnrollment, mfaStatus, verifyTotp } from "@/application/mfa";
import { totp } from "./support/totp";
import { legacyMfaRecoverySessionFixture } from "./support/mfa-replacement";
import { listMyOrganizations } from "@/application/organizations";

describe("password recovery", () => {
  it("responds identically to known and unknown addresses and sends a native one-hour recovery email", async () => {
    const user = await provisionedUser();
    const authentication = passwordRecoveryAuthenticationFixture();
    expect(await requestPasswordRecovery(anonymousClient(), authentication, user.email))
      .toEqual({ ok: true, value: null });
    expect(await requestPasswordRecovery(anonymousClient(), authentication, uniqueEmail()))
      .toEqual({ ok: true, value: null });
    const email = await recoveryEmailFixture(user.email);
    expect(email.url.origin).toBe("http://127.0.0.1:3103");
    expect(email.url.pathname).toBe("/password/reset");
    expect(email.requestToken).toMatch(/^[a-f0-9]{64}$/);
    expect(email.tokenHash.length).toBeGreaterThan(20);
    expect(email.html.includes("one hour")).toBe(true);
    expect(email.html.includes("jednu hodinu")).toBe(true);
    expect(email.html.includes("Obnovit heslo iVAT")).toBe(true);
    expect(email.subject).toBe("Obnova hesla iVAT / Reset your iVAT password");
  });

  it("only verifies on explicit action, resets without the old password, and keeps the current session while revoking other refresh sessions", async () => {
    const user = await provisionedUser();
    const other = anonymousClient();
    await other.auth.signInWithPassword({ email: user.email, password: "correct-horse-battery" });
    const authentication = passwordRecoveryAuthenticationFixture();
    await requestPasswordRecovery(anonymousClient(), authentication, user.email);
    const email = await recoveryEmailFixture(user.email);
    const visitor = anonymousClient();
    expect(await recoveryLinkStatus(visitor, email.requestToken)).toBe("valid");
    expect(await recoveryLinkStatus(visitor, email.requestToken)).toBe("valid");
    expect((await visitor.auth.getUser()).data.user).toBeNull();
    expect(await verifyPasswordRecovery(visitor, authentication, email)).toEqual({ ok: true, value: null });
    expect((await anonymousClient().auth.verifyOtp({ token_hash: email.tokenHash, type: "recovery" })).error?.code).toBe("otp_expired");
    const before = (await visitor.auth.getClaims()).data?.claims.session_id;
    expect(await recoveryStatus(visitor)).toBe("ready");
    expect(await recoverPassword(visitor, { newPassword: "recovered-password-167", confirmation: "different" }))
      .toEqual({ ok: false, error: "password_confirmation_mismatch" });
    expect(await recoverPassword(visitor, { newPassword: "short", confirmation: "short" }))
      .toEqual({ ok: false, error: "weak_password" });
    expect(await recoverPassword(visitor, { newPassword: "correct-horse-battery", confirmation: "correct-horse-battery" }))
      .toEqual({ ok: false, error: "same_password" });
    expect(await recoveryStatus(visitor)).toBe("ready");
    expect(await recoverPassword(visitor, { newPassword: "recovered-password-167", confirmation: "recovered-password-167" }))
      .toEqual({ ok: true, value: null });
    expect(await recoveryStatus(visitor)).toBe("complete");
    expect((await visitor.auth.refreshSession()).error).toBeNull();
    expect((await visitor.auth.getClaims()).data?.claims.session_id).toBe(before);
    expect((await other.auth.refreshSession()).error).not.toBeNull();
    expect((await user.client.auth.refreshSession()).error).not.toBeNull();
    expect((await anonymousClient().auth.signInWithPassword({ email: user.email, password: "correct-horse-battery" })).error).not.toBeNull();
    expect((await anonymousClient().auth.signInWithPassword({ email: user.email, password: "recovered-password-167" })).error).toBeNull();
    expect(await recoveryLinkStatus(visitor, email.requestToken)).toBe("used");
    expect(await verifyPasswordRecovery(anonymousClient(), authentication, email)).toEqual({ ok: false, error: "recovery_link_used" });
    expect(await recoverPassword(visitor, { newPassword: "repeat-password-167", confirmation: "repeat-password-167" }))
      .toEqual({ ok: false, error: "recovery_link_used" });
  });

  it("requires actual TOTP elevation and preserves the enrolled factor, including when a legacy backup flag is present", async () => {
    const user = await provisionedUser();
    const enrollment = await beginTotpEnrollment(user.client);
    if (!enrollment.ok) throw new Error(enrollment.error);
    const enrolled = await completeTotpEnrollment(user.client, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) });
    if (!enrolled.ok) throw new Error(enrolled.error);
    const authentication = passwordRecoveryAuthenticationFixture();
    await requestPasswordRecovery(anonymousClient(), authentication, user.email);
    const email = await recoveryEmailFixture(user.email);
    const visitor = anonymousClient();
    expect(await verifyPasswordRecovery(visitor, authentication, email)).toEqual({ ok: true, value: null });
    expect(await listMyOrganizations(visitor)).toEqual([]);
    const password = { newPassword: "protected-password-167", confirmation: "protected-password-167" };
    expect(await recoverPassword(visitor, password)).toEqual({ ok: false, error: "mfa_verification_required" });
    expect((await visitor.auth.updateUser({ password: password.newPassword })).error?.code).toBe("insufficient_aal");
    await legacyMfaRecoverySessionFixture(visitor);
    expect(await recoverPassword(visitor, password)).toEqual({ ok: false, error: "mfa_verification_required" });
    expect(await verifyTotp(visitor, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) })).toEqual({ ok: true, value: null });
    expect(await recoverPassword(visitor, password)).toEqual({ ok: true, value: null });
    expect(await mfaStatus(visitor)).toMatchObject({ enrolled: true, currentLevel: "aal2", factorId: enrollment.value.factorId });
    expect(await listMyOrganizations(visitor)).toHaveLength(1);
  });

  it("does not authorize ordinary or generic OTP sessions and hides private recovery records", async () => {
    const user = await provisionedUser();
    const password = { newPassword: "unauthorized-password-167", confirmation: "unauthorized-password-167" };
    expect(await recoverPassword(user.client, password)).toEqual({ ok: false, error: "recovery_link_invalid" });
    const magic = await magicLinkSessionFixture(user.email);
    expect((await magic.auth.getClaims()).data?.claims.amr).toEqual([expect.objectContaining({ method: "otp" })]);
    expect(await recoverPassword(magic, password)).toEqual({ ok: false, error: "recovery_link_invalid" });
    expect((await user.client.rpc("create_password_recovery_request", { target_email: user.email })).error?.code).toBe("42501");
    expect((await user.client.rpc("authorize_password_recovery", { request_token: "guess", verified_session_id: crypto.randomUUID() })).error?.code).toBe("42501");
    const inaccessible = await user.client.schema("private" as "public").from("password_recovery_intent" as "membership").select("*");
    expect(inaccessible.error?.code).toBe("PGRST106");
  });

  it("enforces the native one-hour email-token lifetime independently of the application request", async () => {
    const user = await provisionedUser();
    const authentication = passwordRecoveryAuthenticationFixture();
    await requestPasswordRecovery(anonymousClient(), authentication, user.email);
    const email = await recoveryEmailFixture(user.email);
    await ageNativeRecoveryFixture(user.email, 61);
    const visitor = anonymousClient();
    expect(await recoveryLinkStatus(visitor, email.requestToken)).toBe("valid");
    expect(await verifyPasswordRecovery(visitor, authentication, email)).toEqual({ ok: false, error: "recovery_link_invalid" });
    expect((await visitor.auth.getUser()).data.user).toBeNull();
  });

  it("reports expired and invalid request capabilities without establishing a session", async () => {
    const user = await provisionedUser();
    const authentication = passwordRecoveryAuthenticationFixture();
    await requestPasswordRecovery(anonymousClient(), authentication, user.email);
    const email = await recoveryEmailFixture(user.email);
    await expireRecoveryRequestFixture(email.requestToken);
    const visitor = anonymousClient();
    expect(await recoveryLinkStatus(visitor, email.requestToken)).toBe("expired");
    expect(await verifyPasswordRecovery(visitor, authentication, email)).toEqual({ ok: false, error: "recovery_link_expired" });
    expect(await verifyPasswordRecovery(visitor, authentication, { ...email, requestToken: "invalid" }))
      .toEqual({ ok: false, error: "recovery_link_invalid" });
    expect((await visitor.auth.getUser()).data.user).toBeNull();
  });

  it("serializes simultaneous native verification so only one browser obtains recovery authority", async () => {
    const user = await provisionedUser();
    const authentication = passwordRecoveryAuthenticationFixture();
    await requestPasswordRecovery(anonymousClient(), authentication, user.email);
    const email = await recoveryEmailFixture(user.email);
    const browsers = [anonymousClient(), anonymousClient()];
    const results = await Promise.all(browsers.map(client => verifyPasswordRecovery(client, authentication, email)));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    const winner = results[0].ok ? 0 : 1;
    expect((await browsers[1 - winner].auth.getUser()).data.user).toBeNull();
    expect(await recoveryStatus(browsers[winner])).toBe("ready");
  });

  it("refuses pairing another User's native email token with a recovery request", async () => {
    const a = await provisionedUser();
    const b = await provisionedUser();
    const authentication = passwordRecoveryAuthenticationFixture();
    await requestPasswordRecovery(anonymousClient(), authentication, a.email);
    await requestPasswordRecovery(anonymousClient(), authentication, b.email);
    const [first, second] = await Promise.all([recoveryEmailFixture(a.email), recoveryEmailFixture(b.email)]);
    const visitor = anonymousClient();
    expect(await verifyPasswordRecovery(visitor, authentication, { requestToken: second.requestToken, tokenHash: first.tokenHash }))
      .toEqual({ ok: false, error: "recovery_link_invalid" });
    expect((await visitor.auth.getUser()).data.user).toBeNull();
    expect(await recoveryLinkStatus(visitor, second.requestToken)).toBe("valid");
    expect(await verifyPasswordRecovery(visitor, authentication, second)).toEqual({ ok: true, value: null });
    expect((await visitor.auth.getUser()).data.user?.id).toBe(b.userId);
  });
});
