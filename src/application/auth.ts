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

export async function logIn(client: AppClient, input: LogInInput): Promise<Result<null, "invalid_credentials">> {
  const { error } = await client.auth.signInWithPassword({ email: input.email.trim(), password: input.password });
  if (error) return { ok: false, error: "invalid_credentials" };
  return { ok: true, value: null };
}

/** The id of the signed-in user, or null. */
export async function currentUserId(client: AppClient): Promise<string | null> {
  const { data } = await client.auth.getUser();
  return data.user?.id ?? null;
}

export async function logOut(client: AppClient): Promise<void> {
  await client.auth.signOut();
}

/** Establishes a session from a cross-browser email link token. */
export async function verifyEmailOtp(client: AppClient, tokenHash: string, type: EmailOtpType): Promise<boolean> {
  const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
  return !error;
}

/** Establishes a session from a PKCE callback (for example OAuth). */
export async function exchangeAuthCode(client: AppClient, code: string): Promise<boolean> {
  const { error } = await client.auth.exchangeCodeForSession(code);
  return !error;
}
