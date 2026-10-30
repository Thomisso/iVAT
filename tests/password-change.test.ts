import { expect, inject, it } from "vitest";
import { changePassword } from "@/application/password-change";
import { supabasePasswordVerifier } from "@/application/supabase-password-verifier";
import { anonymousClient, provisionedUser, uniqueEmail } from "./support/clients";
import { beginTotpEnrollment, completeTotpEnrollment, mfaStatus } from "@/application/mfa";
import { totp } from "./support/totp";
import { systemClient } from "./support/worker";

const originalPassword = "correct-horse-battery";
const newPassword = "a-new-password-165";
const verifier = () => supabasePasswordVerifier(inject("supabaseUrl"), inject("supabaseAnonKey"));

it("refuses an incorrect current password through real Auth without replacing the session", async () => {
  const user = await provisionedUser();
  const before = (await user.client.auth.getSession()).data.session!;
  expect(await changePassword(user.client, verifier(), {
    currentPassword: "wrong-password", newPassword, confirmation: newPassword,
  })).toEqual({ ok: false, error: "incorrect_current_password" });
  const after = (await user.client.auth.getSession()).data.session!;
  expect(after.access_token).toBe(before.access_token);
  expect(after.refresh_token).toBe(before.refresh_token);
  expect((await anonymousClient().auth.signInWithPassword({ email: user.email, password: originalPassword })).error).toBeNull();
  expect((await anonymousClient().auth.signInWithPassword({ email: user.email, password: newPassword })).error).not.toBeNull();
});

it("keeps the original session, revokes other refresh sessions and destroys the verifier session", async () => {
  const user = await provisionedUser();
  const other = anonymousClient();
  const otherSession = (await other.auth.signInWithPassword({ email: user.email, password: originalPassword })).data.session!;
  const before = (await user.client.auth.getSession()).data.session!;
  let ephemeralRefreshToken = "";
  const transport: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).includes("grant_type=password") && response.ok) ephemeralRefreshToken = (await response.clone().json()).refresh_token;
    return response;
  };
  expect(await changePassword(user.client, supabasePasswordVerifier(inject("supabaseUrl"), inject("supabaseAnonKey"), transport), {
    currentPassword: originalPassword, newPassword, confirmation: newPassword,
  })).toEqual({ ok: true, value: null });
  const after = (await user.client.auth.getSession()).data.session!;
  expect(after.access_token).toBe(before.access_token);
  expect(after.refresh_token).toBe(before.refresh_token);
  expect((await user.client.auth.getUser()).data.user?.id).toBe(user.userId);
  expect((await other.auth.refreshSession({ refresh_token: otherSession.refresh_token })).error).not.toBeNull();
  expect(ephemeralRefreshToken).not.toBe("");
  expect((await anonymousClient().auth.refreshSession({ refresh_token: ephemeralRefreshToken })).error).not.toBeNull();
  expect((await user.client.auth.refreshSession()).error).toBeNull();
  expect((await anonymousClient().auth.signInWithPassword({ email: user.email, password: originalPassword })).error).not.toBeNull();
  expect((await anonymousClient().auth.signInWithPassword({ email: user.email, password: newPassword })).error).toBeNull();
});

it("requires actual MFA and preserves the original AAL2 session and enrolled factor", async () => {
  const user = await provisionedUser();
  const enrollment = await beginTotpEnrollment(user.client);
  if (!enrollment.ok) throw new Error(enrollment.error);
  const completed = await completeTotpEnrollment(user.client, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) });
  if (!completed.ok) throw new Error(completed.error);
  const lower = anonymousClient();
  await lower.auth.signInWithPassword({ email: user.email, password: originalPassword });
  const change = { currentPassword: originalPassword, newPassword, confirmation: newPassword };
  expect(await changePassword(lower, verifier(), change)).toEqual({ ok: false, error: "mfa_verification_required" });
  const before = (await user.client.auth.getSession()).data.session!;
  expect(await changePassword(user.client, verifier(), change)).toEqual({ ok: true, value: null });
  const after = (await user.client.auth.getSession()).data.session!;
  expect(after.access_token).toBe(before.access_token);
  expect(after.refresh_token).toBe(before.refresh_token);
  expect(await mfaStatus(user.client)).toEqual(expect.objectContaining({ enrolled: true, currentLevel: "aal2", factorId: enrollment.value.factorId }));
  expect((await user.client.auth.refreshSession()).error).toBeNull();
  expect((await lower.auth.refreshSession()).error).not.toBeNull();
  expect((await anonymousClient().auth.signInWithPassword({ email: user.email, password: newPassword })).error).toBeNull();
});

it("validates normal password fields before any verification, including an empty current password", async () => {
  const user = await provisionedUser();
  const change = { currentPassword: originalPassword, newPassword, confirmation: newPassword };
  expect(await changePassword(user.client, verifier(), { ...change, currentPassword: "" })).toEqual({ ok: false, error: "current_password_required" });
  expect(await changePassword(user.client, verifier(), { ...change, confirmation: "different-password" })).toEqual({ ok: false, error: "password_confirmation_mismatch" });
  expect(await changePassword(user.client, verifier(), { ...change, newPassword: "short", confirmation: "short" })).toEqual({ ok: false, error: "weak_password" });
  expect(await changePassword(user.client, verifier(), { ...change, newPassword: originalPassword, confirmation: originalPassword })).toEqual({ ok: false, error: "same_password" });
});

it("revokes the temporary verifier session even when no password change follows", async () => {
  const user = await provisionedUser();
  let ephemeralRefreshToken = "";
  const transport: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).includes("grant_type=password") && response.ok) ephemeralRefreshToken = (await response.clone().json()).refresh_token;
    return response;
  };
  expect(await supabasePasswordVerifier(inject("supabaseUrl"), inject("supabaseAnonKey"), transport).verify({ userId: user.userId, email: user.email, password: originalPassword })).toEqual({ ok: true, value: null });
  expect(ephemeralRefreshToken).not.toBe("");
  expect((await anonymousClient().auth.refreshSession({ refresh_token: ephemeralRefreshToken })).error).not.toBeNull();
  expect((await user.client.auth.refreshSession()).error).toBeNull();
});

it("keeps normal change separate from first-password setup and genuine recovery sessions", async () => {
  const email = uniqueEmail();
  const created = await systemClient().auth.admin.createUser({ email, email_confirm: true });
  if (created.error) throw created.error;
  const initialLink = await systemClient().auth.admin.generateLink({ type: "magiclink", email });
  if (initialLink.error) throw initialLink.error;
  const initial = anonymousClient();
  const signedIn = await initial.auth.verifyOtp({ type: "magiclink", token_hash: initialLink.data.properties.hashed_token });
  if (signedIn.error) throw signedIn.error;
  expect(await changePassword(initial, verifier(), { currentPassword: "", newPassword, confirmation: newPassword })).toEqual({ ok: false, error: "current_password_required" });
  // Initial setup is a distinct native Auth operation for an identity with no password.
  expect((await initial.auth.updateUser({ password: originalPassword })).error).toBeNull();

  const recoveryLink = await systemClient().auth.admin.generateLink({ type: "recovery", email });
  if (recoveryLink.error) throw recoveryLink.error;
  const recovery = anonymousClient();
  const recovered = await recovery.auth.verifyOtp({ type: "recovery", token_hash: recoveryLink.data.properties.hashed_token });
  if (recovered.error) throw recovered.error;
  const claims = JSON.parse(Buffer.from(recovered.data.session!.access_token.split(".")[1], "base64url").toString());
  // Pinned GoTrue issues an `otp` AMR for verifyOtp(type: recovery), not a literal `recovery`.
  expect(claims.amr).toContainEqual(expect.objectContaining({ method: "otp" }));
  expect(await changePassword(recovery, verifier(), { currentPassword: "wrong-password", newPassword, confirmation: newPassword })).toEqual({ ok: false, error: "incorrect_current_password" });
  expect((await anonymousClient().auth.signInWithPassword({ email, password: originalPassword })).error).toBeNull();
});

it("refuses the change if the temporary verifier session cannot be revoked", async () => {
  const user = await provisionedUser();
  let ephemeralAccessToken = "";
  const transport: typeof fetch = async (input, init) => {
    if (String(input).includes("/logout")) return Response.json({ code: "unexpected_failure", msg: "Temporary Auth failure" }, { status: 500 });
    const response = await fetch(input, init);
    if (String(input).includes("grant_type=password") && response.ok) ephemeralAccessToken = (await response.clone().json()).access_token;
    return response;
  };
  try {
    expect(await changePassword(user.client, supabasePasswordVerifier(inject("supabaseUrl"), inject("supabaseAnonKey"), transport), {
      currentPassword: originalPassword, newPassword, confirmation: newPassword,
    })).toEqual({ ok: false, error: "password_verification_failed" });
    expect((await user.client.auth.refreshSession()).error).toBeNull();
    expect((await anonymousClient().auth.signInWithPassword({ email: user.email, password: originalPassword })).error).toBeNull();
    expect((await anonymousClient().auth.signInWithPassword({ email: user.email, password: newPassword })).error).not.toBeNull();
  } finally {
    // Restore only the deliberately failed local HTTP boundary and revoke the disposable session.
    if (ephemeralAccessToken) {
      const cleanup = await fetch(`${inject("supabaseUrl")}/auth/v1/logout?scope=local`, {
        method: "POST", headers: { apikey: inject("supabaseAnonKey"), Authorization: `Bearer ${ephemeralAccessToken}` },
      });
      expect(cleanup.ok).toBe(true);
    }
  }
});
