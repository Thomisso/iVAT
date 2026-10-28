import type { EmailOtpType } from "@supabase/supabase-js";
import type { AppClient, Result } from "./client";

export type SignUpInput = { email: string; password: string; organizationName: string };
export type SignUpError = "organization_name_required" | "email_taken" | "weak_password" | "sign_up_failed";

/**
 * Registers a user with email and password. The database creates the user's
 * Organization and Administrator Membership in the same transaction (see the
 * `on_auth_user_created` trigger), so a signed-up user always has one.
 */
export async function signUp(
  client: AppClient,
  input: SignUpInput,
): Promise<Result<{ userId: string }, SignUpError>> {
  const organizationName = input.organizationName.trim();
  if (!organizationName) return { ok: false, error: "organization_name_required" };

  const { data, error } = await client.auth.signUp({
    email: input.email.trim(),
    password: input.password,
    options: { data: { organization_name: organizationName } },
  });
  if (error) {
    if (error.code === "user_already_exists" || error.code === "email_exists") return { ok: false, error: "email_taken" };
    if (error.code === "weak_password") return { ok: false, error: "weak_password" };
    return { ok: false, error: "sign_up_failed" };
  }
  if (!data.user) return { ok: false, error: "sign_up_failed" };
  return { ok: true, value: { userId: data.user.id } };
}

export type LogInInput = { email: string; password: string };

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
): Promise<Result<null, "invalid_credentials" | "organization_blocked">> {
  const { error } = await client.auth.signInWithPassword({ email: input.email.trim(), password: input.password });
  if (error) return { ok: false, error: "invalid_credentials" };
  if (!(await applicationAccessAllowed(client))) {
    return { ok: false, error: "organization_blocked" };
  }
  return { ok: true, value: null };
}

export async function startGoogleSignIn(
  client: AppClient,
  input: { redirectTo: string },
): Promise<Result<{ url: string }, "google_sign_in_failed">> {
  const { data, error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: input.redirectTo, skipBrowserRedirect: true },
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
  const { data } = await client.auth.getUser();
  return data.user?.id ?? null;
}

/** Identity fields safe to render in the signed-in User's account menu. */
export async function currentUser(client: AppClient): Promise<{ id: string; email: string } | null> {
  const { data } = await client.auth.getUser();
  return data.user ? { id: data.user.id, email: data.user.email ?? "" } : null;
}

export async function logOut(client: AppClient): Promise<void> {
  await client.auth.signOut();
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
