import { isAuthRetryableFetchError, type AuthError } from "@supabase/supabase-js";

/** Dependency refusal is different from a missing/revoked native session. */
export function authUnavailable(error: AuthError | null): boolean {
  return !!error && (isAuthRetryableFetchError(error) || !error.status || error.status >= 500 || error.status === 429);
}
