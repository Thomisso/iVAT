import type { AppClient, Result } from "./client";

export type MfaError =
  | "mfa_enrollment_failed"
  | "invalid_mfa_code"
  | "recovery_codes_failed"
  | "mfa_status_failed";

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
  if (authorized.error) return { ok: false, error: "mfa_enrollment_failed" };
  const factors = await client.auth.mfa.listFactors();
  if (factors.error) return { ok: false, error: "mfa_enrollment_failed" };
  for (const factor of factors.data.all) {
    if (factor.factor_type === "totp" && factor.status === "unverified") {
      const stale = await client.auth.mfa.unenroll({ factorId: factor.id });
      if (stale.error) return { ok: false, error: "mfa_enrollment_failed" };
    }
  }
  const { data, error } = await client.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "Authenticator app",
  });
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
  const verified = await client.auth.mfa.challengeAndVerify({
    factorId: input.factorId,
    code: input.code.trim(),
  });
  if (verified.error) return { ok: false, error: "invalid_mfa_code" };

  const generated = await client.rpc("finish_mfa_enrollment");
  if (generated.error) throw generated.error;
  if (generated.data.length !== 10) {
    return { ok: false, error: "recovery_codes_failed" };
  }
  return { ok: true, value: { recoveryCodes: generated.data } };
}

export async function mfaStatus(client: AppClient): Promise<{
  enrolled: boolean;
  currentLevel: string | null;
  nextLevel: string | null;
  factorId: string | null;
  recoveryCodesRemaining: number;
}> {
  const [factors, assurance, recovery, replacement] = await Promise.all([
    client.auth.mfa.listFactors(),
    client.auth.mfa.getAuthenticatorAssuranceLevel(),
    client.rpc("mfa_recovery_codes_remaining"),
    client.rpc("mfa_replacement_status"),
  ]);
  if (factors.error || assurance.error) throw new Error("mfa_status_failed");
  if (replacement.error) throw replacement.error;
  const history = replacement.data as { hasHistory?: boolean; pending?: boolean; factorId?: string | null };
  const factor = history.hasHistory && !history.pending && history.factorId
    ? factors.data.totp.find(item => item.id === history.factorId) ?? null : factors.data.totp[0] ?? null;
  return {
    enrolled: factor !== null,
    currentLevel: assurance.data.currentLevel,
    nextLevel: assurance.data.nextLevel,
    factorId: factor?.id ?? null,
    recoveryCodesRemaining: recovery.error ? 0 : recovery.data,
  };
}

export async function verifyRecoveryCode(
  client: AppClient,
  code: string,
): Promise<Result<null, "invalid_mfa_code" | "email_recovery_required">> {
  const { data, error } = await client.rpc("verify_mfa_recovery_code", {
    input_code: code,
  });
  if (error?.hint === "email_recovery_required") return { ok: false, error: "email_recovery_required" };
  if (error || !data) return { ok: false, error: "invalid_mfa_code" };
  return { ok: true, value: null };
}

export async function verifyTotp(
  client: AppClient,
  input: { factorId: string; code: string },
): Promise<Result<null, "invalid_mfa_code">> {
  const { error } = await client.auth.mfa.challengeAndVerify({
    factorId: input.factorId,
    code: input.code.trim(),
  });
  if (error) return { ok: false, error: "invalid_mfa_code" };
  return { ok: true, value: null };
}

export async function disenrollMfa(
  client: AppClient,
  factorId: string,
): Promise<Result<null, "mfa_disenrollment_failed">> {
  const authorized = await client.rpc("authorize_mfa_maintenance", { operation: "remove" });
  if (authorized.error) return { ok: false, error: "mfa_disenrollment_failed" };
  const removed = await client.auth.mfa.unenroll({ factorId });
  if (removed.error) return { ok: false, error: "mfa_disenrollment_failed" };
  const cleanup = await client.rpc("finish_mfa_disenrollment");
  if (cleanup.error) throw cleanup.error;
  return { ok: true, value: null };
}

export async function setOrganizationMfaRequired(
  client: AppClient,
  input: { organizationId: string; required: boolean },
): Promise<Result<null, "forbidden">> {
  const { error } = await client.rpc("set_organization_mfa_required", {
    target_organization_id: input.organizationId,
    required: input.required,
  });
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error) throw error;
  return { ok: true, value: null };
}

export async function mfaPolicy(client: AppClient): Promise<{
  required: boolean;
  enrolled: boolean;
  satisfied: boolean;
}> {
  const { data, error } = await client.rpc("current_mfa_policy");
  if (error) throw error;
  const policy = data[0];
  if (!policy) throw new Error("mfa_status_failed");
  return policy;
}

export async function listOrganizationMfaSettings(client: AppClient): Promise<
  { id: string; name: string; required: boolean }[]
> {
  const { data, error } = await client.rpc("list_organization_administrations");
  if (error) throw error;
  return (data as unknown as { id: string; name: string; mfaRequired: boolean }[]).map((organization) => ({
    id: organization.id,
    name: organization.name,
    required: organization.mfaRequired,
  }));
}
