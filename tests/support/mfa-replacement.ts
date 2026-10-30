import { inject } from "vitest";
import { supabaseMfaReplacementAuthentication } from "@/auth/supabase-mfa-replacement";
import { createClient } from "@supabase/supabase-js";
import { asUserClient, type AppClient } from "@/application/client";
import { anonymousClient } from "./clients";
import { passwordRecoveryAuthenticationFixture, recoveryEmailFixture } from "./password-recovery";
import { requestPasswordRecovery, verifyPasswordRecovery } from "@/application/password-recovery";

export function mfaReplacementAuthenticationFixture(transport?: typeof fetch) {
  return supabaseMfaReplacementAuthentication({
    url: inject("supabaseUrl"), publishableKey: inject("supabaseAnonKey"), secretKey: inject("supabaseSecretKey"), fetch: transport,
  });
}

/** Keep an actual issued JWT after native revocation, to exercise PostgREST RLS. */
export async function staleAccessTokenFixture(client: AppClient) {
  const token = (await client.auth.getSession()).data.session?.access_token;
  if (!token) throw new Error("Real native access token required");
  return asUserClient(createClient(inject("supabaseUrl"), inject("supabaseAnonKey"), { accessToken: async () => token }));
}

export async function freshEmailRecoveryFixture(email: string, previousRequestToken: string) {
  const authentication = passwordRecoveryAuthenticationFixture();
  for (let attempt = 0; attempt < 5; attempt++) {
    await requestPasswordRecovery(anonymousClient(), authentication, email);
    const message = await recoveryEmailFixture(email);
    if (message.requestToken !== previousRequestToken) {
      const client = anonymousClient();
      const verified = await verifyPasswordRecovery(client, authentication, message);
      if (!verified.ok) throw new Error(verified.error);
      return { client, message };
    }
    // Respect the native per-address mail interval rather than bypassing it.
    await new Promise(resolve => setTimeout(resolve, 1100));
  }
  throw new Error("A fresh native recovery email was not delivered");
}

/** Reproduce a pre-upgrade application-only flag; it must confer no MFA now. */
export async function legacyMfaRecoverySessionFixture(client: import("@/application/client").AppClient) {
  const claims = await client.auth.getClaims();
  const { Client } = await import("pg");
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query("insert into private.mfa_recovery_session(session_id, user_id) values($1,$2)", [claims.data?.claims.session_id, claims.data?.claims.sub]);
  } finally { await database.end(); }
}

export async function expireRecoverySessionFixture(client: AppClient) {
  const claims = await client.auth.getClaims();
  const { Client } = await import("pg");
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try { await database.query("update private.password_recovery_intent set expires_at = now() - interval '1 second' where session_id = $1", [claims.data?.claims.session_id]); }
  finally { await database.end(); }
}

/** Hold one real Auth enroll after authentication but before its factor INSERT. */
export async function delayedNativeEnrollmentFixture(userId: string) {
  if (!/^[a-f0-9-]{36}$/.test(userId)) throw new Error("Fixture User id required");
  const { Client } = await import("pg");
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const name = `test_mfa_gate_${suffix}`;
  const friendlyName = `Late competing factor ${suffix}`;
  const lock = 1_681_000_001;
  await database.query(`create function private.${name}() returns trigger language plpgsql security definer set search_path = '' as $$
    begin if new.user_id = '${userId}'::uuid and new.friendly_name = '${friendlyName}' then
      perform pg_advisory_xact_lock(${lock}); end if; return new; end; $$;
    create trigger ${name} before insert on auth.mfa_factors for each row execute function private.${name}()`);
  await database.query("select pg_advisory_lock($1)", [lock]);
  return {
    friendlyName,
    async waitUntilBlocked() {
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await database.query("select exists(select 1 from pg_locks where locktype = 'advisory' and objid = $1 and not granted) as waiting", [lock]);
        if (result.rows[0].waiting) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("Real native enrollment did not reach its controlled insert boundary");
    },
    async release() { await database.query("select pg_advisory_unlock($1)", [lock]); },
    async dispose() {
      await database.query("select pg_advisory_unlock($1)", [lock]);
      await database.query(`drop trigger if exists ${name} on auth.mfa_factors; drop function if exists private.${name}()`);
      await database.end();
    },
  };
}
