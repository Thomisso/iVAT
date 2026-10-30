import { createClient } from "@supabase/supabase-js";
import type { PasswordRecoveryAuthentication } from "@/application/password-recovery";
import type { Database } from "@/lib/database.types";
import { asUserClient } from "@/application/client";
import { recoveryLinkStatus } from "@/application/password-recovery";

/** Request secrets reach only the native recovery email, never the request response. */
export function supabasePasswordRecovery(configuration: {
  url: string; publishableKey: string; secretKey: string; resetUrl: string;
}): PasswordRecoveryAuthentication {
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const administration = createClient<Database>(configuration.url, configuration.secretKey, options);
  return {
    async request(email) {
      const request = await administration.rpc("create_password_recovery_request", { target_email: email });
      if (request.error) throw new Error("password_recovery_unavailable");
      const redirect = new URL(configuration.resetUrl);
      redirect.hash = new URLSearchParams({ request: request.data }).toString();
      const client = createClient(configuration.url, configuration.publishableKey, options);
      // Known/unknown addresses, SMTP and native rate-limit refusals share one response.
      await client.auth.resetPasswordForEmail(email, { redirectTo: redirect.toString() });
    },
    async verify(input) {
      const client = asUserClient(createClient<Database>(configuration.url, configuration.publishableKey, options));
      const status = await recoveryLinkStatus(client, input.requestToken);
      if (status !== "valid") return { ok: false, error: `recovery_link_${status}` };
      const verified = await client.auth.verifyOtp({ token_hash: input.tokenHash, type: "recovery" });
      if (verified.error || !verified.data.session) return { ok: false, error: "recovery_link_invalid" };
      const claims = await client.auth.getClaims();
      const sessionId = claims.data?.claims.session_id;
      if (typeof sessionId !== "string") {
        await client.auth.signOut({ scope: "local" });
        return { ok: false, error: "password_recovery_failed" };
      }
      const authorized = await administration.rpc("authorize_password_recovery", { request_token: input.requestToken, verified_session_id: sessionId });
      if (authorized.error) {
        await client.auth.signOut({ scope: "local" });
        const state = await recoveryLinkStatus(asUserClient(createClient<Database>(configuration.url, configuration.publishableKey, options)), input.requestToken);
        return { ok: false, error: state === "used" ? "recovery_link_used" : state === "expired" ? "recovery_link_expired" : "recovery_link_invalid" };
      }
      return { ok: true, value: { client, session: verified.data.session } };
    },
  };
}
