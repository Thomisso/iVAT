import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { inject } from "vitest";
import type { AppClient } from "@/application/client";
import { signUp } from "@/application/auth";
import { listMyOrganizations } from "@/application/organizations";

export function anonymousClient(): AppClient {
  return createClient(inject("supabaseUrl"), inject("supabaseAnonKey"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function uniqueEmail(): string {
  return `user-${randomUUID()}@example.test`;
}

/** Signs up a fresh user and returns a client acting as that user, with their Organization. */
export async function signedUpUser(organizationName = "Test Organization") {
  const client = anonymousClient();
  const email = uniqueEmail();
  const result = await signUp(client, { email, password: "correct-horse-battery", organizationName });
  if (!result.ok) throw new Error(`Sign-up failed: ${result.error}`);
  const [organization] = await listMyOrganizations(client);
  return { client, email, userId: result.value.userId, organizationId: organization.id };
}
