import type { AppClient } from "./client";
import type { InvitationMailer } from "./memberships";

/** Sends a passwordless Supabase Auth email. Locally it is captured by Mailpit. */
export function supabaseInvitationMailer(client: AppClient, callbackUrl: string): InvitationMailer {
  return {
    async sendInvitation({ email, acceptUrl }) {
      const destination = new URL(acceptUrl);
      const callback = new URL(callbackUrl);
      callback.searchParams.set("next", `${destination.pathname}${destination.search}`);
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true, emailRedirectTo: callback.toString() },
      });
      if (error) throw error;
    },
  };
}
