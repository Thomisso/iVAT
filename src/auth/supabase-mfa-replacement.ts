import { createClient } from "@supabase/supabase-js";
import type { AppClient, Result } from "@/application/client";
import type { MfaReplacementAuthentication, MfaReplacementError } from "@/application/mfa-replacement";
import type { Database } from "@/lib/database.types";

type Authority = { userId: string; sessionId: string; factorId: string | null; kind: "enroll" | "finish"; removeFactorIds: string[]; passwordUpdated: boolean };
const failed = { ok: false, error: "mfa_recovery_failed" } as const;

/** Supported native operations only, scoped by database-issued recovery claims. */
export function supabaseMfaReplacementAuthentication(configuration: {
  url: string; publishableKey: string; secretKey: string; fetch?: typeof fetch;
}): MfaReplacementAuthentication {
  const transport = configuration.fetch ?? fetch;
  const administration = createClient<Database>(configuration.url, configuration.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport },
  });
  async function authority(operationId: string): Promise<Authority | null> {
    const response = await administration.rpc("mfa_replacement_authority", { recovery_operation_id: operationId });
    if (response.error) return null;
    return response.data as unknown as Authority;
  }
  async function boundClient(client: AppClient, scope: Authority) {
    const [user, claims] = await Promise.all([client.auth.getUser(), client.auth.getClaims()]);
    return user.data.user?.id === scope.userId && claims.data?.claims.session_id === scope.sessionId;
  }
  async function removeAuthorizedFactors(operationId: string, scope: Authority) {
    for (const id of scope.removeFactorIds) {
      const deleted = await administration.auth.admin.mfa.deleteFactor({ userId: scope.userId, id });
      if (deleted.error) {
        const current = await authority(operationId);
        if (!current || current.removeFactorIds.includes(id)) return false;
      }
    }
    return true;
  }
  async function revokeOthers(client: AppClient) {
    const session = await client.auth.getSession();
    if (!session.data.session) return false;
    // Like the normal password verifier, inspect native HTTP success. SDK signOut
    // suppresses some HTTP failures and cannot establish fail-closed revocation.
    const response = await transport(`${configuration.url.replace(/\/$/, "")}/auth/v1/logout?scope=others`, {
      method: "POST", headers: { apikey: configuration.publishableKey, Authorization: `Bearer ${session.data.session.access_token}` },
    }).catch(() => null);
    return response?.ok === true;
  }
  return {
    async enroll(client, operationId) {
      const scope = await authority(operationId);
      if (!scope || scope.kind !== "enroll" || !(await boundClient(client, scope))) return failed;
      if (!(await removeAuthorizedFactors(operationId, scope))) return failed;
      const enrolled = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: `iVAT recovery ${operationId}` });
      if (enrolled.error) return failed;
      const bound = await administration.rpc("bind_mfa_replacement_factor", { recovery_operation_id: operationId, enrolled_factor_id: enrolled.data.id });
      if (bound.error) return failed;
      return { ok: true, value: { factorId: enrolled.data.id, qrCode: enrolled.data.totp.qr_code, secret: enrolled.data.totp.secret, uri: enrolled.data.totp.uri } };
    },
    async finish(client, operationId, password): Promise<Result<null, MfaReplacementError>> {
      let scope = await authority(operationId);
      if (!scope || scope.kind !== "finish" || !(await boundClient(client, scope))) return failed;
      if (!scope.passwordUpdated) {
        const updated = await client.auth.updateUser({ password });
        if (updated.error) {
          if (updated.error.code === "weak_password") return { ok: false, error: "weak_password" };
          if (updated.error.code === "same_password") return { ok: false, error: "same_password" };
          if (updated.error.code === "insufficient_aal") return { ok: false, error: "mfa_verification_required" };
          return failed;
        }
        const recorded = await administration.rpc("confirm_mfa_replacement_password", { recovery_operation_id: operationId });
        if (recorded.error) return failed;
      }
      if (!(await revokeOthers(client))) return failed;
      scope = await authority(operationId);
      if (!scope || !(await removeAuthorizedFactors(operationId, scope))) return failed;
      if (!(await revokeOthers(client))) return failed;
      const confirmed = await administration.rpc("confirm_mfa_replacement_native_finish", { recovery_operation_id: operationId });
      return confirmed.error ? failed : { ok: true, value: null };
    },
  };
}
