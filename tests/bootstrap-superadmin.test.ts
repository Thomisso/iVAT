import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, inject, it } from "vitest";

const bootstrapScript = path.join(process.cwd(), "node_modules", ".bin", "tsx");

function runBootstrap(
  args: string[],
  environment: { supabaseUrl: string; supabaseSecretKey: string },
  input?: string,
) {
  return spawnSync(bootstrapScript, ["scripts/bootstrap-superadmin.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: environment.supabaseUrl,
      SUPABASE_SECRET_KEY: environment.supabaseSecretKey,
    },
    input,
  });
}

describe("SuperAdmin bootstrap command", () => {
  it("refuses a non-local Supabase endpoint without exposing the secret key", () => {
    const secretKey = "service-key-must-stay-secret";
    const result = runBootstrap(
      ["--email", "operator@example.test"],
      { supabaseUrl: "https://example.supabase.co", supabaseSecretKey: secretKey },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("only runs against a local Supabase endpoint");
    expect(output).not.toContain(secretKey);
  });

  it("creates a missing Auth User and idempotently leaves exactly one SuperAdmin record", async () => {
    const environment = {
      supabaseUrl: inject("supabaseUrl"),
      supabaseSecretKey: inject("supabaseSecretKey"),
    };
    const admin = createClient(environment.supabaseUrl, environment.supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const email = `bootstrap-${randomUUID()}@example.test`;
    const password = "one-time-bootstrap-password";

    const first = runBootstrap(["--email", email, "--password-stdin"], environment, `${password}\n`);
    const second = runBootstrap(["--email", email], environment);
    const { data: users, error: usersError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1_000 });
    const matchingUsers = users.users.filter((user) => user.email === email);

    try {
      expect(first.status, first.stderr).toBe(0);
      expect(second.status, second.stderr).toBe(0);
      expect(first.stdout).toContain("SuperAdmin ready");
      expect(second.stdout).toContain("SuperAdmin ready");
      expect(`${first.stdout}${first.stderr}`).not.toContain(password);
      expect(usersError).toBeNull();
      expect(matchingUsers).toHaveLength(1);

      const { count, error: countError } = await admin
        .from("platform_user")
        .select("user_id", { count: "exact", head: true })
        .eq("user_id", matchingUsers[0].id)
        .eq("role", "super_admin");
      expect(countError).toBeNull();
      expect(count).toBe(1);
    } finally {
      if (matchingUsers[0]) await admin.auth.admin.deleteUser(matchingUsers[0].id);
    }
  });

  it("can generate a one-time password without enrolling MFA", async () => {
    const environment = {
      supabaseUrl: inject("supabaseUrl"),
      supabaseSecretKey: inject("supabaseSecretKey"),
    };
    const admin = createClient(environment.supabaseUrl, environment.supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const email = `bootstrap-generated-${randomUUID()}@example.test`;
    const result = runBootstrap(["--email", email], environment);
    const generatedPassword = result.stdout.match(/^Generated one-time password: (\S+)$/m)?.[1];
    const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1_000 });
    const user = users.users.find((candidate) => candidate.email === email);

    try {
      expect(result.status, result.stderr).toBe(0);
      expect(generatedPassword).toBeTruthy();

      const signedIn = createClient(environment.supabaseUrl, inject("supabaseAnonKey"), {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: signInError } = await signedIn.auth.signInWithPassword({
        email,
        password: generatedPassword!,
      });
      expect(signInError).toBeNull();
      const { data: factors, error: factorsError } = await signedIn.auth.mfa.listFactors();
      expect(factorsError).toBeNull();
      expect(factors?.totp).toEqual([]);
    } finally {
      if (user) await admin.auth.admin.deleteUser(user.id);
    }
  });

  it("fails when asked to promote an Auth User that does not exist", () => {
    const missingUserId = randomUUID();
    const result = runBootstrap(
      ["--user-id", missingUserId],
      {
        supabaseUrl: inject("supabaseUrl"),
        supabaseSecretKey: inject("supabaseSecretKey"),
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Auth User ${missingUserId} does not exist`);
    expect(result.stdout).toBe("");
  });
});
