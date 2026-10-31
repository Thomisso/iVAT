import type { AppClient, Result } from "./client";
import type { TotpEnrollment } from "./mfa";

export type MfaReplacementError = "invalid_mfa_code" | "email_recovery_required" | "mfa_recovery_failed" | "mfa_recovery_required" | "mfa_recovery_busy" | "mfa_verification_required" | "weak_password" | "same_password" | "password_confirmation_mismatch";
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
  const { data, error } = await client.rpc("begin_mfa_replacement", { input_code: input.code ?? "", continuation_token: input.continuationToken ?? "" });
  if (error) {
    const expected = refusal(error);
    if (expected) return { ok: false, error: expected };
    throw error;
  }
  return { ok: true, value: { continuationToken: data } };
}

export async function mfaReplacementStatus(client: AppClient): Promise<MfaReplacementStatus> {
  if (!(await client.auth.getUser()).data.user) return { pending: false, authorized: false, factorId: null, factorVerified: false, passwordUpdated: false, completionReady: false, hasHistory: false, accessAllowed: false, needsRecovery: false };
  const { data, error } = await client.rpc("mfa_replacement_status");
  if (error) throw error;
  return data as unknown as MfaReplacementStatus;
}

async function operationClaim(client: AppClient, operation: "enroll" | "finish"): Promise<Result<string, MfaReplacementError>> {
  const { data, error } = await client.rpc("claim_mfa_replacement_operation", { operation });
  if (error) {
    const expected = refusal(error);
    if (expected) return { ok: false, error: expected };
    throw error;
  }
  return { ok: true, value: data };
}

async function releaseOperation(client: AppClient, operationId: string) {
  const { error } = await client.rpc("release_mfa_replacement_operation", { recovery_operation_id: operationId });
  if (error) throw error;
}

export async function startReplacementEnrollment(client: AppClient, authentication: MfaReplacementAuthentication): Promise<Result<TotpEnrollment, MfaReplacementError>> {
  const claim = await operationClaim(client, "enroll");
  if (!claim.ok) return claim;
  try { return await authentication.enroll(client, claim.value); }
  finally { await releaseOperation(client, claim.value); }
}

export async function verifyReplacementAuthenticator(client: AppClient, code: string): Promise<Result<null, MfaReplacementError>> {
  const status = await mfaReplacementStatus(client);
  if (!status.pending || !status.authorized || !status.factorId) return { ok: false, error: "mfa_recovery_required" };
  const verified = await client.auth.mfa.challengeAndVerify({ factorId: status.factorId, code: code.trim() });
  return verified.error ? { ok: false, error: "invalid_mfa_code" } : { ok: true, value: null };
}

async function complete(client: AppClient): Promise<Result<null, MfaReplacementError>> {
  const { error } = await client.rpc("complete_mfa_replacement");
  if (error) {
    const expected = refusal(error);
    if (expected) return { ok: false, error: expected };
    throw error;
  }
  return { ok: true, value: null };
}

export async function finishBackupRecovery(client: AppClient, authentication: MfaReplacementAuthentication,
  input: { newPassword: string; confirmation: string }): Promise<Result<null, MfaReplacementError>> {
  const status = await mfaReplacementStatus(client);
  if (!status.pending || !status.authorized) return { ok: false, error: "mfa_recovery_required" };
  if (status.completionReady) return complete(client);
  if (!status.passwordUpdated) {
    if (input.newPassword !== input.confirmation) return { ok: false, error: "password_confirmation_mismatch" };
    if ([...input.newPassword].length < 8) return { ok: false, error: "weak_password" };
  }
  const claim = await operationClaim(client, "finish");
  if (!claim.ok) return claim;
  try {
    const finished = await authentication.finish(client, claim.value, input.newPassword);
    return finished.ok ? complete(client) : finished;
  } finally { await releaseOperation(client, claim.value); }
}
