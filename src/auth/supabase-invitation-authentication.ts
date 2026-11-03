import { authDependencyUnavailable, authUnavailable } from "@/application/auth-availability";
import { createClient } from "@supabase/supabase-js";
import { asUserClient } from "@/application/client";
import type { InvitationAuthentication } from "@/application/invitation-authentication";
import type { Database } from "@/lib/database.types";

/** Privileged operations stay behind a database-issued, one-minute claim. */
export function supabaseInvitationAuthentication(configuration: {
  url: string;
  publishableKey: string;
  secretKey: string;
  fetch?: typeof fetch;
}): InvitationAuthentication {
  const options = { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: configuration.fetch } };
  const administration = createClient<Database>(configuration.url, configuration.secretKey, options);
  return {
    async authenticate(claimId, password) {
      const response = await administration.rpc("invitation_authentication_authority", { acceptance_claim_id: claimId });
      if (authDependencyUnavailable(response)) return { ok: false, error: "auth_unavailable" };
      const { data, error } = response;
      if (error) return { ok: false, error: "invitation_authentication_failed" };
      const authority = data as { email: string; existingUserId: string | null; newUserId: string | null };
      if (authority.existingUserId === null) {
        if (password.length < 8) return { ok: false, error: "weak_password" };
        const created = await administration.auth.admin.createUser({
          id: authority.newUserId!, email: authority.email, password, email_confirm: true,
          app_metadata: { ivat_invitation_claim: claimId },
        });
        if (authUnavailable(created.error)) return { ok: false, error: "auth_unavailable" };
        if (created.error) {
          if (created.error.code === "weak_password") return { ok: false, error: "weak_password" };
          if (created.error.code === "email_exists" || created.error.code === "user_already_exists") {
            return { ok: false, error: "invitation_identity_changed" };
          }
          return { ok: false, error: "invitation_authentication_failed" };
        }
      }
      const client = asUserClient(createClient<Database>(configuration.url, configuration.publishableKey, options));
      const signedIn = await client.auth.signInWithPassword({ email: authority.email, password });
      if (authUnavailable(signedIn.error)) return { ok: false, error: "auth_unavailable" };
      if (signedIn.error || !signedIn.data.session) return { ok: false, error: "invalid_credentials" };
      return { ok: true, value: { client, session: signedIn.data.session } };
    },
    async abort(claimId) {
      const response = await administration.rpc("abort_invitation_acceptance", { acceptance_claim_id: claimId });
      if (authDependencyUnavailable(response)) return { ok: false, error: "auth_unavailable" };
      if (response.error) throw new Error("invitation_cleanup_failed", { cause: response.error });
      return { ok: true, value: null };
    },
  };
}
