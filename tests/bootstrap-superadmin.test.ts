import { succeeded } from "./support/results";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, inject, it } from "vitest";
import { asUserClient } from "@/application/client";
import { beginTotpEnrollment, completeTotpEnrollment, mfaPolicy } from "@/application/mfa";
import { getCompany, updateCompanyIdentity } from "@/application/companies";
import { listAuditEvents } from "@/application/audit";
import { administratorWithCompany } from "./support/fixtures";
import { anonymousClient, provisionedUser } from "./support/clients";
import { totp } from "./support/totp";

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
    const before = await admin.from("organization").select("id", { count: "exact", head: true });

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
      const memberships = await admin.from("membership").select("id").eq("user_id", matchingUsers[0].id);
      expect(memberships.error).toBeNull();
      expect(memberships.data).toEqual([]);
      const after = await admin.from("organization").select("id", { count: "exact", head: true });
      expect(before.error).toBeNull();
      expect(after.error).toBeNull();
      expect(after.count).toBe(before.count);
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

  it("retains an existing User's Membership and credentials while promoting the real identity", async () => {
    const existing = await provisionedUser("Existing operator history");
    const result = runBootstrap(["--user-id", existing.userId], {
      supabaseUrl: inject("supabaseUrl"), supabaseSecretKey: inject("supabaseSecretKey"),
    });
    expect(result.status, result.stderr).toBe(0);
    const repeated = runBootstrap(["--email", existing.email, "--password-stdin"], {
      supabaseUrl: inject("supabaseUrl"), supabaseSecretKey: inject("supabaseSecretKey"),
    }, "must-not-replace-existing-password");
    expect(repeated.status, repeated.stderr).toBe(0);
    expect((await anonymousClient().auth.signInWithPassword({ email: existing.email, password: "correct-horse-battery" })).error).toBeNull();
    const service = createClient(inject("supabaseUrl"), inject("supabaseSecretKey"));
    const memberships = await service.from("membership").select("organization_id, role").eq("user_id", existing.userId);
    expect(memberships.error).toBeNull();
    expect(memberships.data).toEqual([{ organization_id: existing.organizationId, role: "administrator" }]);
  });

  it("requires native MFA and administers a Company without joining it, retaining the real audit actor", async () => {
    const target = await administratorWithCompany("Native bootstrap support target");
    const email = `bootstrap-native-${randomUUID()}@example.test`;
    const password = "native-bootstrap-password";
    const result = runBootstrap(["--email", email, "--password-stdin"], {
      supabaseUrl: inject("supabaseUrl"), supabaseSecretKey: inject("supabaseSecretKey"),
    }, password);
    expect(result.status, result.stderr).toBe(0);
    const client = asUserClient(createClient(inject("supabaseUrl"), inject("supabaseAnonKey"), { auth: { persistSession: false, autoRefreshToken: false } }));
    const login = await client.auth.signInWithPassword({ email, password });
    expect(login.error).toBeNull();
    expect(await getCompany(client, target.companyId)).toBeNull();
    expect(succeeded(await mfaPolicy(client))).toEqual({ required: true, enrolled: false, satisfied: false });
    const enrollment = await beginTotpEnrollment(client);
    if (!enrollment.ok) throw new Error(enrollment.error);
    const completed = await completeTotpEnrollment(client, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) });
    expect(completed.ok).toBe(true);
    const company = await getCompany(client, target.companyId);
    if (!company) throw new Error("Native AAL2 platform access missing");
    expect(await updateCompanyIdentity(client, { ...company, companyId: company.id, name: "Native platform support" })).toEqual({ ok: true, value: null });
    expect((await listAuditEvents(client, target.organizationId)).at(-1)).toEqual(expect.objectContaining({
      action: "company.updated", actorUserId: login.data.user!.id,
    }));
    const historicalMemberships = await client.from("membership").select("id").eq("user_id", login.data.user!.id);
    expect(historicalMemberships.error).toBeNull();
    expect(historicalMemberships.data).toEqual([]);
  });

  it("restricts reservations to the service boundary and binds the native identity to its email", async () => {
    const ordinary = await provisionedUser("Unprivileged reservation caller");
    for (const client of [anonymousClient(), ordinary.client]) {
      expect((await client.rpc("reserve_superadmin_identity", { target_email: ordinary.email })).error?.code).toBe("42501");
      expect((await client.rpc("release_superadmin_identity", { reserved_user_id: randomUUID() })).error?.code).toBe("42501");
    }
    const service = createClient(inject("supabaseUrl"), inject("supabaseSecretKey"));
    const email = `reserved-${randomUUID()}@example.test`;
    const reserved = await service.rpc("reserve_superadmin_identity", { target_email: email });
    expect(reserved.error).toBeNull();
    try {
      const attributes = { id: reserved.data, email: `mismatch-${randomUUID()}@example.test`, password: "native-bootstrap-password", email_confirm: true };
      const created = await service.auth.admin.createUser(attributes);
      expect(created.error).not.toBeNull();
      expect((await service.auth.admin.getUserById(reserved.data)).data.user).toBeNull();
    } finally {
      expect((await service.rpc("release_superadmin_identity", { reserved_user_id: reserved.data })).error).toBeNull();
    }
    const attributes = { id: reserved.data, email, password: "native-bootstrap-password", email_confirm: true };
    const delayed = await service.auth.admin.createUser(attributes);
    try {
      expect(delayed.error).not.toBeNull();
      expect(delayed.data.user).toBeNull();
    } finally {
      if (delayed.data.user) await service.auth.admin.deleteUser(delayed.data.user.id);
    }
  });
});
