import { authDependencyUnavailable, authUnavailable } from "./auth-availability";
import type { AppClient, Result } from "./client";

export type MfaError =
  | "auth_unavailable"
  | "mfa_enrollment_failed"
  | "invalid_mfa_code"
  | "recovery_codes_failed"
  | "mfa_status_failed"
  | "mfa_setup_expired";

export type TotpEnrollment = {
  factorId: string;
  qrCode: string;
  secret: string;
  uri: string;
};

export async function beginTotpEnrollment(
  client: AppClient,
): Promise<Result<TotpEnrollment, MfaError>> {
  const authorized = await client.rpc("authorize_mfa_maintenance", { operation: "enroll" });
  if (authorized.error?.code === "42501" || authorized.error?.code === "P0001" && authorized.error.hint === "mfa_recovery_required") return { ok: false, error: "mfa_enrollment_failed" };
  if (authDependencyUnavailable(authorized)) return { ok: false, error: "auth_unavailable" };
  if (authorized.error) throw authorized.error;
  const factors = await client.auth.mfa.listFactors();
  if (authUnavailable(factors.error)) return { ok: false, error: "auth_unavailable" };
  if (factors.error) return { ok: false, error: "mfa_enrollment_failed" };
  for (const factor of factors.data.all) {
    if (factor.factor_type === "totp" && factor.status === "unverified") {
      const stale = await client.auth.mfa.unenroll({ factorId: factor.id });
      if (authUnavailable(stale.error)) return { ok: false, error: "auth_unavailable" };
      if (stale.error) return { ok: false, error: "mfa_enrollment_failed" };
    }
  }
  const { data, error } = await client.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "Authenticator app",
  });
  if (authUnavailable(error)) return { ok: false, error: "auth_unavailable" };
  if (error) return { ok: false, error: "mfa_enrollment_failed" };
  return {
    ok: true,
    value: {
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      uri: data.totp.uri,
    },
  };
}

export async function completeTotpEnrollment(
  client: AppClient,
  input: { factorId: string; code: string },
): Promise<Result<{ recoveryCodes: string[] }, MfaError>> {
  const claim = await client.rpc("claim_mfa_maintenance", { target_factor_id: input.factorId });
  if (claim.error?.code === "P0001" && claim.error.hint === "mfa_setup_expired") return { ok: false, error: "mfa_setup_expired" };
  if (claim.error?.code === "42501") return { ok: false, error: "mfa_enrollment_failed" };
  if (authDependencyUnavailable(claim)) return { ok: false, error: "auth_unavailable" };
  if (claim.error) throw claim.error;
  const verified = await client.auth.mfa.challengeAndVerify({
    factorId: input.factorId,
    code: input.code.trim(),
  });
  if (authUnavailable(verified.error)) return { ok: false, error: "auth_unavailable" };
  if (verified.error) return { ok: false, error: "invalid_mfa_code" };

  const generated = await client.rpc("finish_mfa_enrollment");
  if (generated.error?.code === "42501") return { ok: false, error: "mfa_enrollment_failed" };
  if (authDependencyUnavailable(generated)) return { ok: false, error: "auth_unavailable" };
  if (generated.error) throw generated.error;
  if (generated.data.length !== 10) {
    return { ok: false, error: "recovery_codes_failed" };
  }
  return { ok: true, value: { recoveryCodes: generated.data } };
}

export type MfaStatus = {
  enrolled: boolean;
  currentLevel: string | null;
  nextLevel: string | null;
  factorId: string | null;
  recoveryCodesRemaining: number;
};

/** Native factors and assurance for the current User; an unavailable policy
 * dependency never becomes a guessed status or a zero recovery-code count. */
export async function mfaStatus(client: AppClient): Promise<Result<MfaStatus, "auth_unavailable" | "mfa_status_failed">> {
  const [factors, assurance, recovery, replacement] = await Promise.all([
    client.auth.mfa.listFactors(),
    client.auth.mfa.getAuthenticatorAssuranceLevel(),
    client.rpc("mfa_recovery_codes_remaining"),
    client.rpc("mfa_replacement_status"),
  ]);
  if (authUnavailable(factors.error) || authUnavailable(assurance.error) || authDependencyUnavailable(recovery) || authDependencyUnavailable(replacement)) return { ok: false, error: "auth_unavailable" };
  if (factors.error || assurance.error) return { ok: false, error: "mfa_status_failed" };
  if (recovery.error) throw recovery.error;
  if (replacement.error) throw replacement.error;
  const history = replacement.data as { hasHistory?: boolean; pending?: boolean; factorId?: string | null };
  const factor = history.hasHistory && !history.pending && history.factorId
    ? factors.data.totp.find(item => item.id === history.factorId) ?? null : factors.data.totp[0] ?? null;
  return { ok: true, value: {
    enrolled: factor !== null,
    currentLevel: assurance.data.currentLevel,
    nextLevel: assurance.data.nextLevel,
    factorId: factor?.id ?? null,
    recoveryCodesRemaining: recovery.data,
  } };
}

export async function verifyRecoveryCode(
  client: AppClient,
  code: string,
): Promise<Result<null, "invalid_mfa_code" | "email_recovery_required" | "auth_unavailable">> {
  const response = await client.rpc("verify_mfa_recovery_code", {
    input_code: code,
  });
  const { data, error } = response;
  if (authDependencyUnavailable(response)) return { ok: false, error: "auth_unavailable" };
  if (error?.hint === "email_recovery_required") return { ok: false, error: "email_recovery_required" };
  if (error || !data) return { ok: false, error: "invalid_mfa_code" };
  return { ok: true, value: null };
}

export async function verifyTotp(
  client: AppClient,
  input: { factorId: string; code: string },
): Promise<Result<null, "invalid_mfa_code" | "auth_unavailable">> {
  const { error } = await client.auth.mfa.challengeAndVerify({
    factorId: input.factorId,
    code: input.code.trim(),
  });
  if (authUnavailable(error)) return { ok: false, error: "auth_unavailable" };
  if (error) return { ok: false, error: "invalid_mfa_code" };
  return { ok: true, value: null };
}

export async function disenrollMfa(
  client: AppClient,
  factorId: string,
): Promise<Result<null, "mfa_disenrollment_failed" | "auth_unavailable">> {
  const authorized = await client.rpc("authorize_mfa_maintenance", { operation: "remove" });
  if (authorized.error?.code === "42501" || authorized.error?.code === "P0001" && authorized.error.hint === "mfa_recovery_required") return { ok: false, error: "mfa_disenrollment_failed" };
  if (authDependencyUnavailable(authorized)) return { ok: false, error: "auth_unavailable" };
  if (authorized.error) throw authorized.error;
  const claim = await client.rpc("claim_mfa_maintenance", { target_factor_id: factorId });
  if (claim.error?.code === "42501" || claim.error?.code === "P0001" && claim.error.hint === "mfa_setup_expired") return { ok: false, error: "mfa_disenrollment_failed" };
  if (authDependencyUnavailable(claim)) return { ok: false, error: "auth_unavailable" };
  if (claim.error) throw claim.error;
  const removed = await client.auth.mfa.unenroll({ factorId });
  if (authUnavailable(removed.error)) return { ok: false, error: "auth_unavailable" };
  if (removed.error) return { ok: false, error: "mfa_disenrollment_failed" };
  const cleanup = await client.rpc("finish_mfa_disenrollment");
  if (cleanup.error?.code === "42501") return { ok: false, error: "mfa_disenrollment_failed" };
  if (authDependencyUnavailable(cleanup)) return { ok: false, error: "auth_unavailable" };
  if (cleanup.error) throw cleanup.error;
  return { ok: true, value: null };
}

export async function setOrganizationMfaRequired(
  client: AppClient,
  input: { organizationId: string; required: boolean },
): Promise<Result<null, "forbidden" | "auth_unavailable">> {
  const response = await client.rpc("set_organization_mfa_required", {
    target_organization_id: input.organizationId,
    required: input.required,
  });
  if (authDependencyUnavailable(response)) return { ok: false, error: "auth_unavailable" };
  if (response.error?.code === "42501") return { ok: false, error: "forbidden" };
  if (response.error) throw response.error;
  return { ok: true, value: null };
}

export type MfaPolicy = { required: boolean; enrolled: boolean; satisfied: boolean };

/** Database-authoritative current User policy, including native MFA assurance. */
export async function mfaPolicy(client: AppClient): Promise<Result<MfaPolicy, "auth_unavailable" | "mfa_status_failed">> {
  const response = await client.rpc("current_mfa_policy");
  if (authDependencyUnavailable(response)) return { ok: false, error: "auth_unavailable" };
  if (response.error) throw response.error;
  const policy = response.data[0];
  if (!policy) return { ok: false, error: "mfa_status_failed" };
  return { ok: true, value: policy };
}

/** Organization settings visible under this User's database-authoritative scope. */
export async function listOrganizationMfaSettings(client: AppClient): Promise<Result<
  { id: string; name: string; required: boolean }[], "auth_unavailable"
>> {
  const response = await client.rpc("list_organization_administrations");
  if (authDependencyUnavailable(response)) return { ok: false, error: "auth_unavailable" };
  if (response.error) throw response.error;
  const organizations = response.data as unknown as { id: string; name: string; mfaRequired: boolean }[];
  return { ok: true, value: organizations.map(organization => ({
    id: organization.id,
    name: organization.name,
    required: organization.mfaRequired,
  })) };
}
