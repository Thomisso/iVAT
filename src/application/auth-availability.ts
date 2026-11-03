import { isAuthRetryableFetchError, type AuthError } from "@supabase/supabase-js";

/** Dependency refusal is different from a missing/revoked native session. */
export function authUnavailable(error: AuthError | null): boolean {
  return !!error && (isAuthRetryableFetchError(error) || error.name === "AuthUnknownError" || (error.status ?? 0) >= 500 || error.status === 429);
}

/** Auth journeys also require database-authoritative policy/maintenance RPCs. */
export function authDependencyUnavailable(response: { error: unknown; status: number }): boolean {
  return !!response.error && (response.status === 0 || response.status === 429 || response.status >= 500);
}
