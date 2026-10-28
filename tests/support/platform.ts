import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { inject } from "vitest";
import { asUserClient } from "@/application/client";
import { signedUpUser } from "./clients";
import { systemClient } from "./worker";

/** Authenticated client whose JWT satisfies platform-administration MFA policy. */
export function aal2Client(userId: string, sessionPrefix = "platform-test") {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1_000);
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    aud: "authenticated",
    exp: now + 3_600,
    iat: now,
    sub: userId,
    role: "authenticated",
    aal: "aal2",
    session_id: `${sessionPrefix}-${userId}`,
  })}`;
  const signature = createHmac("sha256", inject("supabaseJwtSecret")).update(unsigned).digest("base64url");
  return asUserClient(createClient(inject("supabaseUrl"), inject("supabaseAnonKey"), {
    accessToken: async () => `${unsigned}.${signature}`,
    auth: { persistSession: false, autoRefreshToken: false },
  }));
}

/** A signed-up Organization Administrator promoted through the test fixture boundary. */
export async function promotedSuperAdministrator(organizationName: string, sessionPrefix = "platform-test") {
  const user = await signedUpUser(organizationName);
  const promoted = await systemClient().from("platform_user").insert({
    user_id: user.userId,
    role: "super_admin",
  });
  if (promoted.error) throw promoted.error;
  return { ...user, client: aal2Client(user.userId, sessionPrefix) };
}
