import { createClient } from "@supabase/supabase-js";
import type { AppClient, Result } from "@/application/client";
import { authDependencyUnavailable, authUnavailable } from "@/application/auth-availability";
import type { MfaReplacementAuthentication, MfaReplacementError } from "@/application/mfa-replacement";
import type { Database } from "@/lib/database.types";

type Authority = { userId: string; sessionId: string; factorId: string | null; kind: "enroll" | "finish"; removeFactorIds: string[]; passwordUpdated: boolean };
const failed = { ok: false, error: "mfa_recovery_failed" } as const;
const unavailable = { ok: false, error: "auth_unavailable" } as const;
const success = { ok: true, value: null } as const;

/** Supported native operations only, scoped by database-issued recovery claims. */
export function supabaseMfaReplacementAuthentication(configuration: {
  url: string; publishableKey: string; secretKey: string; fetch?: typeof fetch;
}): MfaReplacementAuthentication {
  const transport = configuration.fetch ?? fetch;
  const administration = createClient<Database>(configuration.url, configuration.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport },
  });
  async function authority(operationId: string): Promise<Result<Authority, MfaReplacementError>> {
    const response = await administration.rpc("mfa_replacement_authority", { recovery_operation_id: operationId });
    if (authDependencyUnavailable(response)) return unavailable;
    return response.error ? failed : { ok: true, value: response.data as unknown as Authority };
  }
  async function boundClient(client: AppClient, scope: Authority): Promise<Result<null, MfaReplacementError>> {
    const [user, claims] = await Promise.all([client.auth.getUser(), client.auth.getClaims()]);
    if (authUnavailable(user.error) || authUnavailable(claims.error)) return unavailable;
    return user.data.user?.id === scope.userId && claims.data?.claims.session_id === scope.sessionId ? success : failed;
  }
  async function removeAuthorizedFactors(operationId: string, scope: Authority): Promise<Result<null, MfaReplacementError>> {
    for (const id of scope.removeFactorIds) {
      const deleted = await administration.auth.admin.mfa.deleteFactor({ userId: scope.userId, id });
      if (authUnavailable(deleted.error)) return unavailable;
      if (deleted.error) {
        const current = await authority(operationId);
        if (!current.ok) return current;
        if (current.value.removeFactorIds.includes(id)) return failed;
      }
    }
    return success;
  }
  async function revokeOthers(client: AppClient): Promise<Result<null, MfaReplacementError>> {
    const session = await client.auth.getSession();
    if (authUnavailable(session.error)) return unavailable;
    if (!session.data.session) return failed;
    // Inspect native HTTP success: SDK signOut suppresses some HTTP refusals.
    const response = await transport(`${configuration.url.replace(/\/$/, "")}/auth/v1/logout?scope=others`, {
      method: "POST", headers: { apikey: configuration.publishableKey, Authorization: `Bearer ${session.data.session.access_token}` },
    }).catch(() => null);
    if (!response || response.status === 429 || response.status >= 500) return unavailable;
    return response.ok ? success : failed;
  }
  return {
    async enroll(client, operationId) {
      const authorized = await authority(operationId);
      if (!authorized.ok) return authorized;
      const scope = authorized.value;
      if (scope.kind !== "enroll") return failed;
      const bound = await boundClient(client, scope);
      if (!bound.ok) return bound;
      const removed = await removeAuthorizedFactors(operationId, scope);
      if (!removed.ok) return removed;
      const enrolled = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: `iVAT recovery ${operationId}` });
      if (authUnavailable(enrolled.error)) return unavailable;
      if (enrolled.error) return failed;
      const binding = await administration.rpc("bind_mfa_replacement_factor", { recovery_operation_id: operationId, enrolled_factor_id: enrolled.data.id });
      if (authDependencyUnavailable(binding)) return unavailable;
      if (binding.error) return failed;
      return { ok: true, value: { factorId: enrolled.data.id, qrCode: enrolled.data.totp.qr_code, secret: enrolled.data.totp.secret, uri: enrolled.data.totp.uri } };
    },
    async finish(client, operationId, password): Promise<Result<null, MfaReplacementError>> {
      let authorized = await authority(operationId);
      if (!authorized.ok) return authorized;
      const scope = authorized.value;
      if (scope.kind !== "finish") return failed;
      const bound = await boundClient(client, scope);
      if (!bound.ok) return bound;
      if (!scope.passwordUpdated) {
        const updated = await client.auth.updateUser({ password });
        if (authUnavailable(updated.error)) return unavailable;
        if (updated.error) {
          if (updated.error.code === "weak_password") return { ok: false, error: "weak_password" };
          if (updated.error.code === "same_password") return { ok: false, error: "same_password" };
          if (updated.error.code === "insufficient_aal") return { ok: false, error: "mfa_verification_required" };
          return failed;
        }
        const recorded = await administration.rpc("confirm_mfa_replacement_password", { recovery_operation_id: operationId });
        if (authDependencyUnavailable(recorded)) return unavailable;
        if (recorded.error) return failed;
      }
      const revoked = await revokeOthers(client);
      if (!revoked.ok) return revoked;
      authorized = await authority(operationId);
      if (!authorized.ok) return authorized;
      const removed = await removeAuthorizedFactors(operationId, authorized.value);
      if (!removed.ok) return removed;
      const revokedAgain = await revokeOthers(client);
      if (!revokedAgain.ok) return revokedAgain;
      const confirmed = await administration.rpc("confirm_mfa_replacement_native_finish", { recovery_operation_id: operationId });
      if (authDependencyUnavailable(confirmed)) return unavailable;
      return confirmed.error ? failed : success;
    },
  };
}
