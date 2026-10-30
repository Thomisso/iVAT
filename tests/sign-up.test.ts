import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { inject } from "vitest";
import { completeGoogleSignIn, startGoogleSignIn } from "@/application/auth";
import { listMyOrganizations } from "@/application/organizations";
import { asUserClient, type AppClient } from "@/application/client";
import { provisionedUser, uniqueEmail } from "./support/clients";

function googleAuthBoundary(result: {
  data: { url: string | null };
  error: { message: string } | null;
}): AppClient {
  return {
    auth: {
      signInWithOAuth: async () => result,
    },
  } as unknown as AppClient;
}

function googleCallbackBoundary(error: { message: string } | null): AppClient {
  return {
    auth: {
      exchangeCodeForSession: async () => ({ data: { session: null, user: null }, error }),
      signOut: async () => ({ error: null }),
    },
    rpc: async () => ({ data: true, error: null }),
  } as unknown as AppClient;
}

describe("sign-up", () => {
  it("creates an Organization and makes the user its Administrator", async () => {
    const { client } = await provisionedUser("Novák s.r.o.");

    const organizations = await listMyOrganizations(client);

    expect(organizations).toEqual([
      { id: expect.any(String), name: "Novák s.r.o.", role: "administrator" },
    ]);
  });

  it("creates the same Organization Membership for a first-time Google user", async () => {
    const email = uniqueEmail();
    const password = "correct-horse-battery";
    const admin = createClient(inject("supabaseUrl"), inject("supabaseSecretKey"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Jana Nováková" },
    });
    expect(createError).toBeNull();

    const client = asUserClient(
      createClient(inject("supabaseUrl"), inject("supabaseAnonKey"), {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    );
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    expect(signInError).toBeNull();

    expect(await listMyOrganizations(client)).toEqual([
      { id: expect.any(String), name: "Jana Nováková", role: "administrator" },
    ]);
  });

  it("starts Google sign-in at the configured callback", async () => {
    const result = await startGoogleSignIn(
      googleAuthBoundary({
        data: { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=ivat" },
        error: null,
      }),
      { redirectTo: "http://127.0.0.1:3000/auth/callback" },
    );

    expect(result).toEqual({
      ok: true,
      value: { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=ivat" },
    });
  });

  it("reports a stable refusal when Google sign-in cannot start", async () => {
    const result = await startGoogleSignIn(
      googleAuthBoundary({
        data: { url: null },
        error: { message: "provider is not enabled" },
      }),
      { redirectTo: "http://127.0.0.1:3000/auth/callback" },
    );

    expect(result).toEqual({ ok: false, error: "google_sign_in_failed" });
  });

  it("completes Google sign-in by exchanging its one-time code", async () => {
    await expect(completeGoogleSignIn(googleCallbackBoundary(null), "one-time-code")).resolves.toEqual({
      ok: true,
      value: null,
    });
  });

  it("reports a stable refusal when the Google callback is invalid", async () => {
    await expect(
      completeGoogleSignIn(googleCallbackBoundary({ message: "invalid auth code" }), "expired-code"),
    ).resolves.toEqual({ ok: false, error: "google_sign_in_failed" });
  });
});
