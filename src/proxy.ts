import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabasePublishableKey, supabaseUrl } from "@/lib/env";
import { mfaRedirectPath } from "@/application/mfa-routing";

const PUBLIC_PATHS = ["/login", "/signup", "/auth/callback", "/invitations/accept", "/password/forgot", "/password/reset"];
const PUBLIC_ASSETS = new Set(["/brand/logo.svg", "/brand/mark.svg", "/icon.svg", "/icon1.png", "/apple-icon.png"]);

// Refreshes the Supabase session cookie on every request and sends anonymous
// visitors to the login page. Pages still check the user themselves.
export async function proxy(request: NextRequest) {
  // Brand assets remain available before login and during pending MFA, without session routing.
  if (PUBLIC_ASSETS.has(request.nextUrl.pathname)) return NextResponse.next();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await supabase.auth.getUser();
  if (!data.user && !PUBLIC_PATHS.includes(request.nextUrl.pathname)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (data.user) {
    const policy = await supabase.rpc("current_mfa_policy");
    const current = policy.data?.[0];
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
