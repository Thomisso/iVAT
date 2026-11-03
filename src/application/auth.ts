import type { EmailOtpType } from "@supabase/supabase-js";
import type { AppClient, Result } from "./client";
import { authUnavailable } from "./auth-availability";
import { invitationUrls } from "./invitation-urls";

export type SignUpInput = { email: string; password: string; organizationName: string };
export type SignUpError = "registration_closed";

/** Public registration is closed; private provisioning is an operator or
 * administrator-issued invitation boundary, never a fallback from this command. */
export async function signUp(
  _client: AppClient,
  _input: SignUpInput,
): Promise<Result<{ userId: string }, SignUpError>> {
  void _client;
  void _input;
  return { ok: false, error: "registration_closed" };
}

export type LogInInput = { email: string; password: string };

export type AuthProviderConfiguration = { supabaseUrl: string; publishableKey: string };

/** Reads public Auth provider configuration. Fail closed when
 * the provider is unavailable or Auth would permit public account creation. */
export async function googleSignInAvailable(
  _client: AppClient,
  configuration: AuthProviderConfiguration,
  request: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await request(new URL("auth/v1/settings", `${configuration.supabaseUrl.replace(/\/$/, "")}/`), {
      headers: { apikey: configuration.publishableKey },
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const settings = await response.json() as { external?: { google?: unknown }; disable_signup?: unknown };
    return settings.external?.google === true && settings.disable_signup === true;
  } catch {
    return false;
  }
}

async function applicationAccessAllowed(client: AppClient): Promise<boolean> {
  const { data, error } = await client.rpc("current_user_can_use_application");
  if (error) throw error;
  if (data) return true;
  await client.auth.signOut();
  return false;
}

export async function logIn(
  client: AppClient,
  input: LogInInput,
): Promise<Result<null, "invalid_credentials" | "login_rate_limited" | "login_unavailable" | "organization_blocked">> {
  const { error } = await client.auth.signInWithPassword({ email: input.email.trim(), password: input.password });
  if (error) {
    if (error.code === "invalid_credentials") return { ok: false, error: "invalid_credentials" };
    // Keep credentials, provider messages and session data out of operational logs.
    console.error("[auth:login-failed]", { name: error.name, code: error.code, status: error.status });
    return {
      ok: false,
      error: error.status === 429 ? "login_rate_limited" : "login_unavailable",
    };
  }
  if (!(await applicationAccessAllowed(client))) {
    return { ok: false, error: "organization_blocked" };
  }
  return { ok: true, value: null };
}

export async function startGoogleSignIn(
  client: AppClient,
  input: AuthProviderConfiguration & { appOrigin: string | undefined; authRedirectAllowlist: string | undefined },
  request: typeof fetch = fetch,
): Promise<Result<{ url: string }, "google_sign_in_failed">> {
  const urls = invitationUrls(input);
  if (!urls.ok || !(await googleSignInAvailable(client, input, request))) {
    return { ok: false, error: "google_sign_in_failed" };
  }
  const { data, error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: urls.value.callbackUrl, skipBrowserRedirect: true },
  });
  if (error || !data.url) return { ok: false, error: "google_sign_in_failed" };
  return { ok: true, value: { url: data.url } };
}

export async function completeGoogleSignIn(
  client: AppClient,
  code: string,
): Promise<Result<null, "google_sign_in_failed" | "organization_blocked">> {
  const { error } = await client.auth.exchangeCodeForSession(code);
  if (error) return { ok: false, error: "google_sign_in_failed" };
  if (!(await applicationAccessAllowed(client))) {
    return { ok: false, error: "organization_blocked" };
  }
  return { ok: true, value: null };
}

/** The id of the signed-in user, or null. */
export async function currentUserId(client: AppClient): Promise<string | null> {
  return (await currentUser(client))?.id ?? null;
}

/** Identity fields safe to render in the signed-in User's account menu. */
export async function currentUser(client: AppClient): Promise<{ id: string; email: string } | null> {
  const { data, error } = await client.auth.getUser();
  if (authUnavailable(error)) throw new Error("auth_unavailable");
  return data.user ? { id: data.user.id, email: data.user.email ?? "" } : null;
}

export async function logOut(client: AppClient): Promise<Result<null, "auth_unavailable">> {
  const { error } = await client.auth.signOut();
  return error ? { ok: false, error: "auth_unavailable" } : { ok: true, value: null };
}

/** Establishes a session from a cross-browser email link token. */
export async function verifyEmailOtp(
  client: AppClient,
  tokenHash: string,
  type: EmailOtpType,
): Promise<Result<null, "email_otp_failed" | "organization_blocked">> {
  const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) return { ok: false, error: "email_otp_failed" };
  if (!(await applicationAccessAllowed(client))) return { ok: false, error: "organization_blocked" };
  return { ok: true, value: null };
}

/** Establishes the temporary session needed for a new invitee to set a password. */
export async function verifyInvitationEmailOtp(
  client: AppClient,
  tokenHash: string,
): Promise<Result<null, "email_otp_failed">> {
  const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  return error ? { ok: false, error: "email_otp_failed" } : { ok: true, value: null };
}
