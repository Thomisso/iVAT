import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { exchangeAuthCode, verifyEmailOtp } from "@/application/auth";
import { createRequestClient } from "@/lib/supabase/server";

const EMAIL_OTP_TYPES: EmailOtpType[] = ["email", "email_change", "invite", "magiclink", "recovery", "signup"];

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const requestedType = request.nextUrl.searchParams.get("type");
  const requested = request.nextUrl.searchParams.get("next") ?? "/";
  const next = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
  const client = await createRequestClient();
  if (tokenHash && EMAIL_OTP_TYPES.includes(requestedType as EmailOtpType)) {
    if (await verifyEmailOtp(client, tokenHash, requestedType as EmailOtpType)) {
      return NextResponse.redirect(new URL(next, request.url));
    }
  }
  if (code) {
    if (await exchangeAuthCode(client, code)) return NextResponse.redirect(new URL(next, request.url));
  }
  return NextResponse.redirect(new URL("/login", request.url));
}
