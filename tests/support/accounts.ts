import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

export type AccountFixtureInput = {
  email: string;
  password: string;
  organizationName?: string;
};

/** Private test setup; callers still authenticate through the real Auth service. */
export async function provisionAccountFixture(service: SupabaseClient<Database>, input: AccountFixtureInput) {
  const { data, error } = await service.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: input.organizationName === undefined ? {} : { organization_name: input.organizationName },
  });
  if (error) throw error;
  if (!data.user) throw new Error("Private account provisioning did not return a User");
  return data.user.id;
}
