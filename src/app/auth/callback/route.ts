import { NextResponse } from "next/server";
import { completeGoogleSignIn } from "@/application/auth";
import { createRequestClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  if (code) {
    const result = await completeGoogleSignIn(await createRequestClient(), code);
    if (result.ok) return NextResponse.redirect(new URL("/", requestUrl.origin));
  }
  return NextResponse.redirect(new URL("/login?error=google_sign_in_failed", requestUrl.origin));
}
