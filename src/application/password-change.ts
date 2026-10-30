import type { AppClient, Result } from "./client";

export type PasswordVerificationError = "incorrect_current_password" | "password_verification_failed";
export interface PasswordVerifier {
  verify(input: { userId: string; email: string; password: string }): Promise<Result<null, PasswordVerificationError>>;
}
export type PasswordChangeError = PasswordVerificationError | "password_change_failed" | "weak_password" | "same_password" | "mfa_verification_required" | "mfa_recovery_required" | "current_password_required" | "password_confirmation_mismatch";

/** Normal credential maintenance; first-password setup and recovery use their own flows. */
export async function changePassword(
  client: AppClient,
  verifier: PasswordVerifier,
  input: { currentPassword: string; newPassword: string; confirmation: string },
): Promise<Result<null, PasswordChangeError>> {
  const recovery = await client.rpc("mfa_replacement_status");
  if (recovery.error) throw recovery.error;
  const state = recovery.data as { pending?: boolean; hasHistory?: boolean; accessAllowed?: boolean };
  if (state?.pending || state?.hasHistory && !state.accessAllowed) return { ok: false, error: "mfa_recovery_required" };
  if (!input.currentPassword) return { ok: false, error: "current_password_required" };
  if (input.newPassword !== input.confirmation) return { ok: false, error: "password_confirmation_mismatch" };
  if ([...input.newPassword].length < 8) return { ok: false, error: "weak_password" };
  const { data, error } = await client.auth.getUser();
  if (error || !data.user?.email) return { ok: false, error: "password_change_failed" };
  const verified = await verifier.verify({ userId: data.user.id, email: data.user.email, password: input.currentPassword });
  if (!verified.ok) return verified;
  // Updating the ORIGINAL client preserves its session id and actual MFA assurance.
  // Pinned Auth revokes other refresh sessions as part of this supported operation.
  const updated = await client.auth.updateUser({ password: input.newPassword, current_password: input.currentPassword });
  if (updated.error) {
    if (updated.error.code === "weak_password") return { ok: false, error: "weak_password" };
    if (updated.error.code === "same_password") return { ok: false, error: "same_password" };
    if (updated.error.code === "insufficient_aal") return { ok: false, error: "mfa_verification_required" };
    if (updated.error.code === "current_password_mismatch") return { ok: false, error: "incorrect_current_password" };
    return { ok: false, error: "password_change_failed" };
  }
  return { ok: true, value: null };
}
