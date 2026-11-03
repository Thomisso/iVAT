import { NextResponse, type NextRequest } from "next/server";
import { supabasePublishableKey, supabaseUrl } from "@/lib/env";
import { createSessionClient } from "@/lib/supabase/session-client";
import { serverSupabaseFetch } from "@/lib/supabase/server-transport";
import { authUnavailable } from "@/application/auth-availability";
import cs from "../messages/cs.json";
import en from "../messages/en.json";
import { mfaRedirectPath } from "@/application/mfa-routing";

const PUBLIC_PATHS = ["/login", "/signup", "/auth/callback", "/invitations/accept", "/password/forgot", "/password/reset"];
const PUBLIC_ASSETS = new Set(["/brand/logo.svg", "/brand/mark.svg", "/icon.svg", "/icon1.png", "/apple-icon.png"]);

// Refreshes the Supabase session cookie on every request and sends anonymous
// visitors to the login page. Pages still check the user themselves.
export async function proxy(request: NextRequest) {
  // Brand assets remain available before login and during pending MFA, without session routing.
  if (PUBLIC_ASSETS.has(request.nextUrl.pathname)) return NextResponse.next();
  let response = NextResponse.next({ request });

  const supabase = createSessionClient(supabaseUrl, supabasePublishableKey, {
    fetch: serverSupabaseFetch,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers).forEach(([name, value]) => response.headers.set(name, value));
      },
    },
  });

  const unavailable = () => {
    const result = new NextResponse(
      (request.cookies.get("NEXT_LOCALE")?.value === "en" ? en : cs).errors.auth_unavailable,
      { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30", "Content-Type": "text/plain; charset=utf-8" } },
    );
    // A successful refresh may precede a later policy/database outage. Retain
    // those rotated tokens even while refusing access to protected content.
    response.cookies.getAll().forEach(cookie => result.cookies.set(cookie));
    return result;
  };
  const { data, error } = await supabase.auth.getUser();
  if (authUnavailable(error)) return unavailable();
  if (!data.user && !PUBLIC_PATHS.includes(request.nextUrl.pathname)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (data.user) {
    const recovery = await supabase.rpc("mfa_replacement_status");
    if (recovery.error) return unavailable();
    const recoveryState = recovery.data as { pending?: boolean; needsRecovery?: boolean };
    if (recoveryState?.pending || recoveryState?.needsRecovery) {
      if (!["/password/reset", "/password/forgot", "/auth/callback", "/login"].includes(request.nextUrl.pathname)) {
        return NextResponse.redirect(new URL("/password/reset", request.url));
      }
      return response;
    }
    const policy = await supabase.rpc("current_mfa_policy");
    if (policy.error || !policy.data?.[0]) return unavailable();
    const current = policy.data[0];
    if (current) {
      const destination = mfaRedirectPath(request.nextUrl.pathname, current);
      if (destination) return NextResponse.redirect(new URL(destination, request.url));
    }
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
