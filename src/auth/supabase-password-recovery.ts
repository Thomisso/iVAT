import { authDependencyUnavailable, authUnavailable } from "@/application/auth-availability";
import { createClient } from "@supabase/supabase-js";
import type { PasswordRecoveryAuthentication } from "@/application/password-recovery";
import type { Database } from "@/lib/database.types";
import { asUserClient } from "@/application/client";
import { recoveryLinkStatus } from "@/application/password-recovery";
import { authDependencyAvailable } from "./auth-dependency";

/** Request secrets reach only the native recovery email, never the request response. */
export function supabasePasswordRecovery(configuration: {
  url: string; publishableKey: string; secretKey: string; resetUrl: string; fetch?: typeof fetch;
}): PasswordRecoveryAuthentication {
  const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: configuration.fetch } };
  const administration = createClient<Database>(configuration.url, configuration.secretKey, options);
  return {
    async request(email) {
      // Check the dependency without an email first. Native mail/SMTP/rate-limit
      // refusals remain private: they can differ for known and unknown Users.
      const available = await authDependencyAvailable(configuration);
      if (!available) return { ok: false, error: "auth_unavailable" };
      const request = await administration.rpc("create_password_recovery_request", { target_email: email });
      if (authDependencyUnavailable(request)) return { ok: false, error: "auth_unavailable" };
      if (request.error) throw new Error("password_recovery_unavailable");
      const redirect = new URL(configuration.resetUrl);
      redirect.hash = new URLSearchParams({ request: request.data }).toString();
      const client = createClient(configuration.url, configuration.publishableKey, options);
      // The public acknowledgement never asserts delivery. Even a recover-only
      // outage stays non-enumerating; verification/reset failures stay explicit.
      await client.auth.resetPasswordForEmail(email, { redirectTo: redirect.toString() });
      return { ok: true, value: null };
    },
    async verify(input) {
      const client = asUserClient(createClient<Database>(configuration.url, configuration.publishableKey, options));
      const status = await recoveryLinkStatus(client, input.requestToken);
      if (!status.ok) return status;
      if (status.value !== "valid") return { ok: false, error: `recovery_link_${status.value}` };
      const verified = await client.auth.verifyOtp({ token_hash: input.tokenHash, type: "recovery" });
      if (authUnavailable(verified.error)) return { ok: false, error: "auth_unavailable" };
      if (verified.error || !verified.data.session) return { ok: false, error: "recovery_link_invalid" };
      const claims = await client.auth.getClaims();
      if (authUnavailable(claims.error)) return { ok: false, error: "auth_unavailable" };
      const sessionId = claims.data?.claims.session_id;
      if (typeof sessionId !== "string") {
        await client.auth.signOut({ scope: "local" });
        return { ok: false, error: "password_recovery_failed" };
      }
      const authorized = await administration.rpc("authorize_password_recovery", { request_token: input.requestToken, verified_session_id: sessionId });
      if (authDependencyUnavailable(authorized)) return { ok: false, error: "auth_unavailable" };
      if (authorized.error) {
        await client.auth.signOut({ scope: "local" });
        const state = await recoveryLinkStatus(asUserClient(createClient<Database>(configuration.url, configuration.publishableKey, options)), input.requestToken);
        if (!state.ok) return state;
        return { ok: false, error: state.value === "used" ? "recovery_link_used" : state.value === "expired" ? "recovery_link_expired" : "recovery_link_invalid" };
      }
      return { ok: true, value: { client, session: verified.data.session } };
    },
  };
}
