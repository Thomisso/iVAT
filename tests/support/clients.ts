import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { inject } from "vitest";
import { asUserClient, type AppClient } from "@/application/client";
import type { Database } from "@/lib/database.types";
import { listMyOrganizations } from "@/application/organizations";
import { provisionAccountFixture, type AccountFixtureInput } from "./accounts";

export function anonymousClient(): AppClient {
  return asUserClient(
    createClient(inject("supabaseUrl"), inject("supabaseAnonKey"), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }),
  );
}

export function uniqueEmail(): string {
  return `user-${randomUUID()}@example.test`;
}

/** Privately provisions an account and signs in as that User through real Auth. */
export async function provisionedAccount(input: AccountFixtureInput) {
  const service = createClient<Database>(inject("supabaseUrl"), inject("supabaseSecretKey"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const userId = await provisionAccountFixture(service, input);
  const client = anonymousClient();
  const { error } = await client.auth.signInWithPassword({ email: input.email, password: input.password });
  if (error) throw error;
  return { client, email: input.email, userId };
}

/** Returns a privately provisioned Administrator and their own Organization. */
export async function provisionedUser(organizationName = "Test Organization") {
  const user = await provisionedAccount({ email: uniqueEmail(), password: "correct-horse-battery", organizationName });
  const { client } = user;
  const [organization] = await listMyOrganizations(client);
  if (!organization) throw new Error("Private account provisioning did not create its Organization");
  return { ...user, organizationId: organization.id };
}
