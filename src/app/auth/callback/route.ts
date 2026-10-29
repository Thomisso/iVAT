import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { completeGoogleSignIn, verifyEmailOtp, verifyInvitationEmailOtp } from "@/application/auth";
import { createRequestClient } from "@/lib/supabase/server";

const EMAIL_OTP_TYPES: EmailOtpType[] = ["email", "email_change", "invite", "magiclink", "recovery", "signup"];

export async function GET(request: NextRequest) {
  const appOrigin = process.env.APP_ORIGIN ?? request.url;
  const code = request.nextUrl.searchParams.get("code");
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const requestedType = request.nextUrl.searchParams.get("type");
  const requested = request.nextUrl.searchParams.get("next") ?? "/";
  const next = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
  const invitationCallback = new URL(next, request.url).pathname === "/invitations/accept";
  const client = await createRequestClient();

  if (tokenHash && EMAIL_OTP_TYPES.includes(requestedType as EmailOtpType)) {
    const result = invitationCallback && requestedType === "magiclink"
      ? await verifyInvitationEmailOtp(client, tokenHash)
      : await verifyEmailOtp(client, tokenHash, requestedType as EmailOtpType);
    if (result.ok) {
      return NextResponse.redirect(new URL(next, appOrigin));
    }
    if ("error" in result && result.error === "organization_blocked") {
      return NextResponse.redirect(new URL("/login?error=organization_blocked", appOrigin));
    }
    if (invitationCallback) return NextResponse.redirect(new URL(next, appOrigin));
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
