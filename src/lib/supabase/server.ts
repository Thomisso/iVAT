import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { asUserClient, type AppClient, type Result } from "@/application/client";
import { supabasePublishableKey, supabaseUrl } from "@/lib/env";
import { currentUser } from "@/application/auth";
import { createSessionClient } from "./session-client";
import { serverSupabaseFetch } from "./server-transport";

/** A Supabase client acting as the user of the current request. */
export async function createRequestClient(): Promise<AppClient> {
  const cookieStore = await cookies();
  const client = createSessionClient(supabaseUrl, supabasePublishableKey, {
    fetch: serverSupabaseFetch,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot set cookies; the proxy refreshes the session instead.
        }
      },
    },
  });
  return asUserClient(client);
}

/** The current request's client, redirecting to login when nobody is signed in. */
export async function requireUserClient(): Promise<AppClient> {
  const client = await createRequestClient();
  const user = availableAuthValue(await currentUser(client));
  if (!user) redirect("/login");
  return client;
}

/** Map an expected account-dependency refusal at a page/action boundary. The
 * stateless unavailable surface translates it without entering MFA routing. */
export function availableAuthValue<T>(result: Result<T, "auth_unavailable" | "mfa_status_failed">): T {
  if (!result.ok) redirect("/auth/unavailable");
  return result.value;
}
