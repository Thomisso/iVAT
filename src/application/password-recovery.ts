import type { AppClient, Result } from "./client";
import type { Session } from "@supabase/supabase-js";

export type RecoveryLinkError = "recovery_link_invalid" | "recovery_link_expired" | "recovery_link_used";
export type RecoveryError = RecoveryLinkError | "password_recovery_failed" | "mfa_verification_required" | "mfa_recovery_required" | "weak_password" | "same_password" | "password_confirmation_mismatch";

export interface PasswordRecoveryAuthentication {
  request(email: string): Promise<void>;
  verify(input: { requestToken: string; tokenHash: string }): Promise<Result<{ client: AppClient; session: Session }, RecoveryLinkError | "password_recovery_failed">>;
}

/** A recovery request never reveals whether an address belongs to a User. */
export async function requestPasswordRecovery(
  _client: AppClient,
  authentication: PasswordRecoveryAuthentication,
  email: string,
): Promise<Result<null, never>> {
  await authentication.request(email.trim().toLowerCase());
  return { ok: true, value: null };
}

export async function recoveryLinkStatus(client: AppClient, requestToken: string): Promise<"valid" | "invalid" | "used" | "expired"> {
  const { data, error } = await client.rpc("password_recovery_link_status", { request_token: requestToken });
  if (error) throw error;
  return data as "valid" | "invalid" | "used" | "expired";
}

export async function recoveryStatus(client: AppClient): Promise<"ready" | "complete" | "invalid" | "used" | "expired"> {
  if (!(await client.auth.getUser()).data.user) return "invalid";
  const { data, error } = await client.rpc("password_recovery_status");
  if (error) throw error;
  return data as "ready" | "complete" | "invalid" | "used" | "expired";
}

export async function verifyPasswordRecovery(
  client: AppClient,
  authentication: PasswordRecoveryAuthentication,
  input: { requestToken: string; tokenHash: string },
): Promise<Result<null, RecoveryLinkError | "password_recovery_failed">> {
  const verified = await authentication.verify(input);
  if (!verified.ok) return verified;
  const { session } = verified.value;
  const published = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (published.error) {
    await verified.value.client.auth.signOut({ scope: "local" });
    return { ok: false, error: "password_recovery_failed" };
  }
  return { ok: true, value: null };
}

function recoveryRefusal(error: { code?: string; hint?: string | null }): RecoveryError | null {
  const hint = error.code === "P0001" ? error.hint : null;
  return hint === "recovery_link_invalid" || hint === "recovery_link_used" || hint === "recovery_link_expired"
    || hint === "mfa_verification_required" || hint === "mfa_recovery_required" ? hint : null;
}

export async function recoverPassword(
  client: AppClient,
  input: { newPassword: string; confirmation: string },
): Promise<Result<null, RecoveryError>> {
  if (input.newPassword !== input.confirmation) return { ok: false, error: "password_confirmation_mismatch" };
  if ([...input.newPassword].length < 8) return { ok: false, error: "weak_password" };
  const claimed = await client.rpc("claim_password_recovery");
  if (claimed.error) {
    const refusal = recoveryRefusal(claimed.error);
    if (refusal) return { ok: false, error: refusal };
    if (claimed.error.code === "42501") return { ok: false, error: "recovery_link_invalid" };
    throw claimed.error;
  }
  // Native Auth is the password and MFA authority. It retains this actual
  // session and revokes the account's other refresh sessions atomically.
  const updated = await client.auth.updateUser({ password: input.newPassword });
  const finished = await client.rpc("finish_password_recovery", { recovery_attempt_id: claimed.data, succeeded: !updated.error });
  if (finished.error) throw finished.error;
  if (updated.error) {
    if (updated.error.code === "weak_password") return { ok: false, error: "weak_password" };
    if (updated.error.code === "same_password") return { ok: false, error: "same_password" };
    if (updated.error.code === "insufficient_aal") return { ok: false, error: "mfa_verification_required" };
    return { ok: false, error: "password_recovery_failed" };
  }
  return { ok: true, value: null };
}
