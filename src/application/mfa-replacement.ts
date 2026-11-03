import { authDependencyUnavailable, authUnavailable } from "./auth-availability";
import type { AppClient, Result } from "./client";
import type { TotpEnrollment } from "./mfa";

export type MfaReplacementError = "auth_unavailable" | "invalid_mfa_code" | "email_recovery_required" | "mfa_recovery_failed" | "mfa_recovery_required" | "mfa_recovery_busy" | "mfa_verification_required" | "weak_password" | "same_password" | "password_confirmation_mismatch";
export type MfaReplacementStatus = { pending: boolean; authorized: boolean; factorId: string | null; factorVerified: boolean; passwordUpdated: boolean; completionReady: boolean; hasHistory: boolean; accessAllowed: boolean; needsRecovery: boolean };

export interface MfaReplacementAuthentication {
  enroll(client: AppClient, operationId: string): Promise<Result<TotpEnrollment, MfaReplacementError>>;
  finish(client: AppClient, operationId: string, password: string): Promise<Result<null, MfaReplacementError>>;
}

function refusal(error: { code?: string; hint?: string | null }): MfaReplacementError | null {
  if (error.code === "42501") return "mfa_recovery_required";
  return error.code === "P0001" && (error.hint === "email_recovery_required" || error.hint === "invalid_mfa_code"
    || error.hint === "mfa_recovery_busy" || error.hint === "mfa_verification_required" || error.hint === "mfa_recovery_required") ? error.hint : null;
}

export async function beginBackupRecovery(
  client: AppClient,
  input: { code?: string; continuationToken?: string },
): Promise<Result<{ continuationToken: string }, MfaReplacementError>> {
  const response = await client.rpc("begin_mfa_replacement", { input_code: input.code ?? "", continuation_token: input.continuationToken ?? "" });
  if (authDependencyUnavailable(response)) return { ok: false, error: "auth_unavailable" };
  const { data, error } = response;
  if (error) {
    const expected = refusal(error);
    if (expected) return { ok: false, error: expected };
    throw error;
  }
  return { ok: true, value: { continuationToken: data } };
}

export async function mfaReplacementStatus(client: AppClient): Promise<Result<MfaReplacementStatus, "auth_unavailable">> {
  const user = await client.auth.getUser();
  if (authUnavailable(user.error)) return { ok: false, error: "auth_unavailable" };
  if (!user.data.user) return { ok: true, value: { pending: false, authorized: false, factorId: null, factorVerified: false, passwordUpdated: false, completionReady: false, hasHistory: false, accessAllowed: false, needsRecovery: false } };
  const response = await client.rpc("mfa_replacement_status");
  if (authDependencyUnavailable(response)) return { ok: false, error: "auth_unavailable" };
  if (response.error) throw response.error;
  return { ok: true, value: response.data as unknown as MfaReplacementStatus };
}

async function operationClaim(client: AppClient, operation: "enroll" | "finish"): Promise<Result<string, MfaReplacementError>> {
  const response = await client.rpc("claim_mfa_replacement_operation", { operation });
  if (authDependencyUnavailable(response)) return { ok: false, error: "auth_unavailable" };
  const { data, error } = response;
  if (error) {
    const expected = refusal(error);
    if (expected) return { ok: false, error: expected };
    throw error;
  }
  return { ok: true, value: data };
}

async function releaseOperation(client: AppClient, operationId: string): Promise<Result<null, "auth_unavailable">> {
  const response = await client.rpc("release_mfa_replacement_operation", { recovery_operation_id: operationId });
  if (authDependencyUnavailable(response)) return { ok: false, error: "auth_unavailable" };
  if (response.error) throw response.error;
  return { ok: true, value: null };
}

export async function startReplacementEnrollment(client: AppClient, authentication: MfaReplacementAuthentication): Promise<Result<TotpEnrollment, MfaReplacementError>> {
  const claim = await operationClaim(client, "enroll");
  if (!claim.ok) return claim;
  let result: Result<TotpEnrollment, MfaReplacementError>;
  let released: Result<null, "auth_unavailable">;
  try { result = await authentication.enroll(client, claim.value); }
  finally { released = await releaseOperation(client, claim.value); }
  return released.ok ? result : released;
}

export async function verifyReplacementAuthenticator(client: AppClient, code: string): Promise<Result<null, MfaReplacementError>> {
  const loaded = await mfaReplacementStatus(client);
  if (!loaded.ok) return loaded;
  const status = loaded.value;
  if (!status.pending || !status.authorized || !status.factorId) return { ok: false, error: "mfa_recovery_required" };
  const verified = await client.auth.mfa.challengeAndVerify({ factorId: status.factorId, code: code.trim() });
  if (authUnavailable(verified.error)) return { ok: false, error: "auth_unavailable" };
  return verified.error ? { ok: false, error: "invalid_mfa_code" } : { ok: true, value: null };
}

async function complete(client: AppClient): Promise<Result<null, MfaReplacementError>> {
  const response = await client.rpc("complete_mfa_replacement");
  if (authDependencyUnavailable(response)) return { ok: false, error: "auth_unavailable" };
  const { error } = response;
  if (error) {
    const expected = refusal(error);
    if (expected) return { ok: false, error: expected };
    throw error;
  }
  return { ok: true, value: null };
}

export async function finishBackupRecovery(client: AppClient, authentication: MfaReplacementAuthentication,
  input: { newPassword: string; confirmation: string }): Promise<Result<null, MfaReplacementError>> {
  const loaded = await mfaReplacementStatus(client);
  if (!loaded.ok) return loaded;
  const status = loaded.value;
  if (!status.pending || !status.authorized) return { ok: false, error: "mfa_recovery_required" };
  if (status.completionReady) return complete(client);
  if (!status.passwordUpdated) {
    if (input.newPassword !== input.confirmation) return { ok: false, error: "password_confirmation_mismatch" };
    if ([...input.newPassword].length < 8) return { ok: false, error: "weak_password" };
  }
  const claim = await operationClaim(client, "finish");
  if (!claim.ok) return claim;
  let result: Result<null, MfaReplacementError>;
  let released: Result<null, "auth_unavailable">;
  try {
    const finished = await authentication.finish(client, claim.value, input.newPassword);
    result = finished.ok ? await complete(client) : finished;
  } finally { released = await releaseOperation(client, claim.value); }
  return released.ok ? result : released;
}
