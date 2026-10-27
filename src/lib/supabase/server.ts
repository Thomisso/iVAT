import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { asUserClient, type AppClient } from "@/application/client";
import type { Database } from "@/lib/database.types";
import { supabasePublishableKey, supabaseUrl } from "@/lib/env";

/** A Supabase client acting as the user of the current request. */
export async function createRequestClient(): Promise<AppClient> {
  const cookieStore = await cookies();
  const client = createServerClient<Database>(supabaseUrl, supabasePublishableKey, {
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
  const { data } = await client.auth.getUser();
  if (!data.user) redirect("/login");
  return client;
}
