import "server-only";
import { configuredInvitationUrls } from "./invitations";
import { supabasePasswordRecovery } from "@/auth/supabase-password-recovery";
import { supabasePublishableKey, supabaseUrl } from "./env";

export function passwordRecoveryAuthentication() {
  const urls = configuredInvitationUrls();
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!urls.ok || !secretKey) throw new Error("password_recovery_unavailable");
  return supabasePasswordRecovery({
    url: supabaseUrl, publishableKey: supabasePublishableKey, secretKey,
    resetUrl: new URL("/password/reset", urls.value.callbackUrl).toString(),
  });
}
