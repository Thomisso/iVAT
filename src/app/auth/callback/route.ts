import { invitationUrls } from "@/application/invitation-urls";
import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { completeGoogleSignIn, verifyEmailOtp } from "@/application/auth";
import { createRequestClient } from "@/lib/supabase/server";

const EMAIL_OTP_TYPES: EmailOtpType[] = ["email", "email_change", "invite", "magiclink", "recovery", "signup"];

export async function GET(request: NextRequest) {
  const configured = invitationUrls({ appOrigin: process.env.APP_ORIGIN, authRedirectAllowlist: process.env.AUTH_REDIRECT_ALLOWLIST });
  if (!configured.ok) return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  const appOrigin = new URL(configured.value.callbackUrl).origin;
  const code = request.nextUrl.searchParams.get("code");
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const requestedType = request.nextUrl.searchParams.get("type");
  if (requestedType === "recovery") {
    const landing = new URL("/password/reset", appOrigin);
    landing.hash = new URLSearchParams({ request: request.nextUrl.searchParams.get("request") ?? "", token_hash: tokenHash ?? "" }).toString();
    return NextResponse.redirect(landing);
  }
  const requested = request.nextUrl.searchParams.get("next") ?? "/";
  const next = requested.startsWith("/") && !requested.startsWith("//") && !requested.includes("\\") ? requested : "/";
  const invitationCallback = new URL(next, request.url).pathname === "/invitations/accept";
  // Legacy invitation emails may carry an Auth OTP. Opening an invitation is
  // read-only; the explicit acceptance action authenticates and consumes it.
  if (invitationCallback) return NextResponse.redirect(new URL(next, appOrigin));
  const client = await createRequestClient();

  if (tokenHash && EMAIL_OTP_TYPES.includes(requestedType as EmailOtpType)) {
    const result = await verifyEmailOtp(client, tokenHash, requestedType as EmailOtpType);
    if (result.ok) {
      return NextResponse.redirect(new URL(next, appOrigin));
    }
    if ("error" in result && result.error === "organization_blocked") {
      return NextResponse.redirect(new URL("/login?error=organization_blocked", appOrigin));
    }
  }
  if (code) {
    const result = await completeGoogleSignIn(client, code);
    if (result.ok) return NextResponse.redirect(new URL("/", appOrigin));
    if (result.error === "organization_blocked") {
      return NextResponse.redirect(new URL("/login?error=organization_blocked", appOrigin));
    }
  }
  return NextResponse.redirect(new URL(`/login${code ? "?error=google_sign_in_failed" : ""}`, appOrigin));
}
