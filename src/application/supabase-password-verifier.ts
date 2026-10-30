import { createClient } from "@supabase/supabase-js";
import type { PasswordVerifier } from "./password-change";

/** A new in-memory client per attempt: never shares the request's cookies/storage. */
export function supabasePasswordVerifier(url: string, publishableKey: string, transport: typeof fetch = fetch): PasswordVerifier {
  return {
    async verify({ userId, email, password }) {
      const isolated = createClient(url, publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: transport },
      });
      try {
        const signedIn = await isolated.auth.signInWithPassword({ email, password });
        if (signedIn.error) return { ok: false, error: signedIn.error.code === "invalid_credentials" ? "incorrect_current_password" : "password_verification_failed" };
        // Revoke only this ephemeral session; default/global sign-out would revoke the original.
        const signedOut = await isolated.auth.signOut({ scope: "local" });
        if (signedOut.error || signedIn.data.user.id !== userId) return { ok: false, error: "password_verification_failed" };
        return { ok: true, value: null };
      } finally {
        await isolated.auth.dispose();
      }
    },
  };
}
