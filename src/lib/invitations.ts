import "server-only";
import { serverSupabaseFetch } from "./supabase/server-transport";
import { getTranslations } from "next-intl/server";
import { supabaseInvitationAuthentication } from "@/auth/supabase-invitation-authentication";
import { smtpInvitationMailer } from "@/mail/smtp-invitation-mailer";
import { invitationUrls } from "@/application/invitation-urls";
import { supabasePublishableKey, supabaseUrl } from "./env";

export function configuredInvitationUrls() {
  return invitationUrls({ appOrigin: process.env.APP_ORIGIN, authRedirectAllowlist: process.env.AUTH_REDIRECT_ALLOWLIST });
}

export function invitationAuthentication() {
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) throw new Error("Missing server Auth administration key");
  return supabaseInvitationAuthentication({ url: supabaseUrl, publishableKey: supabasePublishableKey, fetch: serverSupabaseFetch, secretKey });
}

export async function invitationMailer() {
  const t = await getTranslations("members.emailMessage");
  return smtpInvitationMailer({
    host: process.env.SMTP_HOST ?? "", port: Number(process.env.SMTP_PORT ?? "587"),
    user: process.env.SMTP_USER, password: process.env.SMTP_PASS,
    sender: process.env.SMTP_ADMIN_EMAIL ?? "noreply@ivat.cz",
    localCapture: process.env.SMTP_LOCAL_CAPTURE === "true",
  }, { subject: t("subject"), heading: t("heading"), introduction: t("introduction"), linkLabel: t("linkLabel"), expiry: t("expiry") });
}
