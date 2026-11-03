import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

/** One client per request. Preserve the SDK's public cookie namespace and
 * defaults, including chunking/PKCE. Native signOut removes local storage even
 * after a network/5xx refusal; never commit those deletions to browser cookies.
 * The failed request's in-memory client must not be reused for authorization. */
export function createSessionClient(publicUrl: string, publishableKey: string, options: {
  cookies: CookieMethodsServer;
  fetch: typeof fetch;
}) {
  let unavailable = false;
  const transport: typeof fetch = async (input, init) => {
    try {
      const response = await options.fetch(input, init);
      unavailable = response.status >= 500 || response.status === 429;
      return response;
    } catch (error) {
      unavailable = true;
      throw error;
    }
  };
  return createServerClient<Database>(publicUrl, publishableKey, {
    global: { fetch: transport },
    cookies: {
      ...options.cookies,
      setAll: async (cookies, headers) => {
        // A retry may have recovered and rotated tokens: commit that complete
        // update (including obsolete chunk cleanup), but suppress a deletion-only
        // batch after an unavailable dependency.
        if (!unavailable || cookies.some(cookie => cookie.value)) await options.cookies.setAll?.(cookies, headers);
      },
    },
  });
}
