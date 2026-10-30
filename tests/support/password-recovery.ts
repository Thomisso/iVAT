import { inject } from "vitest";
import { supabasePasswordRecovery } from "@/auth/supabase-password-recovery";
import { createClient } from "@supabase/supabase-js";
import { anonymousClient } from "./clients";
import { capturedRecoveryEmail } from "./recovery-mail";

export function passwordRecoveryAuthenticationFixture() {
  return supabasePasswordRecovery({
    url: inject("supabaseUrl"), publishableKey: inject("supabaseAnonKey"), secretKey: inject("supabaseSecretKey"),
    resetUrl: "http://127.0.0.1:3103/password/reset",
  });
}

export async function recoveryEmailFixture(email: string) {
  const mailpit = new URL(inject("supabaseUrl"));
  mailpit.port = String(Number(mailpit.port) + 3);
  return capturedRecoveryEmail(mailpit, email);
}

export async function magicLinkSessionFixture(email: string) {
  const administration = createClient(inject("supabaseUrl"), inject("supabaseSecretKey"), { auth: { persistSession: false, autoRefreshToken: false } });
  const link = await administration.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error) throw link.error;
  const client = anonymousClient();
  const result = await client.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "magiclink" });
  if (result.error) throw result.error;
  return client;
}

/** Move only the native email-token clock; application expiry stays untouched. */
export async function ageNativeRecoveryFixture(email: string, minutes: number) {
  const { Client } = await import("pg");
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try { await database.query("update auth.users set recovery_sent_at = now() - $2 * interval '1 minute' where email = $1", [email, minutes]); }
  finally { await database.end(); }
}

/** Expire only the private request; native verification remains independent. */
export async function expireRecoveryRequestFixture(requestToken: string) {
  const { Client } = await import("pg");
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try { await database.query("update private.password_recovery_request set expires_at = now() - interval '1 second' where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')", [requestToken]); }
  finally { await database.end(); }
}
