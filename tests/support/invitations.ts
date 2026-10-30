import { inject } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { supabaseInvitationAuthentication } from "@/auth/supabase-invitation-authentication";

export function invitationAuthenticationFixture(fetchOverride?: typeof fetch) {
  return supabaseInvitationAuthentication({
    url: inject("supabaseUrl"), publishableKey: inject("supabaseAnonKey"), secretKey: inject("supabaseSecretKey"), fetch: fetchOverride,
  });
}

/** An existing passwordless identity, authenticated by a real Auth email token. */
export async function passwordlessIdentityFixture(email: string) {
  const administration = createClient(inject("supabaseUrl"), inject("supabaseSecretKey"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const created = await administration.auth.admin.createUser({ email, email_confirm: true });
  if (created.error) throw created.error;
  return {
    async authenticate(client: import("@/application/client").AppClient) {
      const link = await administration.auth.admin.generateLink({ type: "magiclink", email });
      if (link.error) throw link.error;
      const verified = await client.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "magiclink" });
      if (verified.error) throw verified.error;
    },
  };
}

/** Controls the Invitation clock while assertions use application queries. */
export async function ageInvitationFixture(token: string, days: number) {
  const { Client } = await import("pg");
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query(`update public.invitation
      set created_at = now() - $2 * interval '1 day', expires_at = now() + (7 - $2) * interval '1 day'
      where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')`, [token, days]);
  } finally { await database.end(); }
}
