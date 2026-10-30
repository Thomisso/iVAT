import { Client as DatabaseClient } from "pg";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { inject } from "vitest";
import { completeGoogleSignIn, googleSignInAvailable, logIn, signUp, startGoogleSignIn } from "@/application/auth";
import { listMyOrganizations } from "@/application/organizations";
import type { AppClient } from "@/application/client";
import { anonymousClient, provisionedUser, uniqueEmail } from "./support/clients";

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
  it("does not advertise unconfigured Google sign-in from the actual Auth settings", async () => {
    expect(await googleSignInAvailable(anonymousClient(), {
      supabaseUrl: inject("supabaseUrl"), publishableKey: inject("supabaseAnonKey"),
    })).toBe(false);
  });
  it("refuses public registration without creating an Auth User or Organization", async () => {
    const email = uniqueEmail();
    const client = anonymousClient();
    expect(await signUp(client, { email, password: "correct-horse-battery", organizationName: "Unrequested Organization" }))
      .toEqual({ ok: false, error: "registration_closed" });
    expect(await listMyOrganizations(client)).toEqual([]);
    const service = createClient(inject("supabaseUrl"), inject("supabaseSecretKey"), { auth: { persistSession: false, autoRefreshToken: false } });
    const users = await service.auth.admin.listUsers();
    expect(users.error).toBeNull();
    expect(users.data.users.find(user => user.email === email)).toBeUndefined();
  });
  it("disables direct Auth signup while retaining password sign-in for privately provisioned Users", async () => {
    const client = anonymousClient();
    const result = await client.auth.signUp({ email: uniqueEmail(), password: "correct-horse-battery", options: { data: { organization_name: "Unrequested Organization" } } });
    expect(result.error?.code).toBe("signup_disabled");
    expect(result.data.user).toBeNull();
    const provisioned = await provisionedUser("Private Organization");
    expect(await logIn(client, { email: provisioned.email, password: "correct-horse-battery" })).toEqual({ ok: true, value: null });
    expect(await listMyOrganizations(client)).toEqual([{ id: provisioned.organizationId, name: "Private Organization", role: "administrator" }]);
  });
  it("creates an Organization and makes the user its Administrator", async () => {
    const { client } = await provisionedUser("Novák s.r.o.");

    const organizations = await listMyOrganizations(client);

    expect(organizations).toEqual([
      { id: expect.any(String), name: "Novák s.r.o.", role: "administrator" },
    ]);
  });

  it("refuses a new OAuth User atomically at the Auth database boundary", async () => {
    const databaseUrl = new URL(inject("databaseUrl"));
    databaseUrl.username = "supabase_auth_admin";
    const database = new DatabaseClient({ connectionString: databaseUrl.toString() });
    await database.connect();
    try {
      await database.query("begin");
      await expect(database.query(
        `insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
         values ($1, $2, '{"provider":"google","providers":["google"]}'::jsonb,
                 '{"full_name":"New Google User","organization_name":"Unrequested Organization"}'::jsonb)`,
        [crypto.randomUUID(), uniqueEmail()],
      )).rejects.toMatchObject({ code: "42501" });
    } finally {
      await database.query("rollback");
      await database.end();
    }
  });

  it("preserves an existing OAuth-linked User's Organization and password credentials", async () => {
    const user = await provisionedUser("Existing Organization");
    const admin = createClient(inject("supabaseUrl"), inject("supabaseSecretKey"), { auth: { persistSession: false, autoRefreshToken: false } });
    const updated = await admin.auth.admin.updateUserById(user.userId, { app_metadata: { provider: "google", providers: ["email", "google"] } });
    expect(updated.error).toBeNull();
    const client = anonymousClient();
    expect(await logIn(client, { email: user.email, password: "correct-horse-battery" })).toEqual({ ok: true, value: null });
    expect(await listMyOrganizations(client)).toEqual([{ id: user.organizationId, name: "Existing Organization", role: "administrator" }]);
  });

  it("starts configured Google sign-in at the trusted, allowlisted callback", async () => {
    const result = await startGoogleSignIn(anonymousClient(), {
      appOrigin: "https://app.example.test", authRedirectAllowlist: "https://app.example.test/auth/callback",
      supabaseUrl: inject("supabaseUrl"), publishableKey: inject("supabaseAnonKey"),
    }, async () => Response.json({ external: { google: true }, disable_signup: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const destination = new URL(result.value.url);
    expect(destination.origin).toBe(inject("supabaseUrl"));
    expect(destination.searchParams.get("provider")).toBe("google");
    expect(destination.searchParams.get("redirect_to")).toBe("https://app.example.test/auth/callback");
  });

  it("reports a stable refusal when Google is not configured", async () => {
    expect(await startGoogleSignIn(anonymousClient(), {
      appOrigin: "https://app.example.test", authRedirectAllowlist: "https://app.example.test/auth/callback",
      supabaseUrl: inject("supabaseUrl"), publishableKey: inject("supabaseAnonKey"),
    })).toEqual({ ok: false, error: "google_sign_in_failed" });
  });

  it("refuses configured Google when public signup is enabled or its callback is not allowlisted", async () => {
    const configuration = {
      appOrigin: "https://app.example.test", authRedirectAllowlist: "https://app.example.test/auth/callback",
      supabaseUrl: inject("supabaseUrl"), publishableKey: inject("supabaseAnonKey"),
    };
    expect(await startGoogleSignIn(anonymousClient(), configuration,
      async () => Response.json({ external: { google: true }, disable_signup: false }),
    )).toEqual({ ok: false, error: "google_sign_in_failed" });
    expect(await startGoogleSignIn(anonymousClient(), { ...configuration, authRedirectAllowlist: "https://other.example.test/auth/callback" },
      async () => Response.json({ external: { google: true }, disable_signup: true }),
    )).toEqual({ ok: false, error: "google_sign_in_failed" });
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
