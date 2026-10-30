import "server-only";
import { supabaseMfaReplacementAuthentication } from "@/auth/supabase-mfa-replacement";
import { configuredInvitationUrls } from "./invitations";
import { supabasePublishableKey, supabaseUrl } from "./env";

export const mfaContinuationCookie = "ivat_mfa_recovery";

export function mfaContinuationCookieOptions() {
  const urls = configuredInvitationUrls();
  if (!urls.ok) throw new Error("mfa_recovery_unavailable");
  return { httpOnly: true, secure: new URL(urls.value.callbackUrl).protocol === "https:", sameSite: "lax" as const, path: "/", maxAge: 7 * 24 * 60 * 60 };
}

export function mfaReplacementAuthentication() {
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) throw new Error("mfa_recovery_unavailable");
  return supabaseMfaReplacementAuthentication({ url: supabaseUrl, publishableKey: supabasePublishableKey, secretKey });
}
