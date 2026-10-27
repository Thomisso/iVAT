import type { AppClient } from "./client";
import type { InvitationMailer } from "./memberships";

/** Sends a passwordless Supabase Auth email. Locally it is captured by Mailpit. */
export function supabaseInvitationMailer(client: AppClient): InvitationMailer {
  return {
    async sendInvitation({ email, acceptUrl }) {
      const destination = new URL(acceptUrl);
      const callback = new URL("/auth/callback", destination.origin);
      callback.searchParams.set("next", `${destination.pathname}${destination.search}`);
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true, emailRedirectTo: callback.toString() },
      });
      if (error) throw error;
    },
  };
}
