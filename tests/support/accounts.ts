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

/** Privileged Auth starting state for dispatch reauthorization tests. */
export async function deactivateAccountFixture(userId: string) {
  const { systemClient } = await import("./worker");
  const result = await systemClient().auth.admin.updateUserById(userId, { ban_duration: "24h" });
  if (result.error) throw result.error;
}

/** Auth-admin setup preserves a genuinely verified replacement address. */
export async function setVerifiedAccountEmailFixture(userId: string, email: string) {
  const { systemClient } = await import("./worker");
  const result = await systemClient().auth.admin.updateUserById(userId, { email, email_confirm: true });
  if (result.error) throw result.error;
}

/** Remove only the synthetic account owned by the requesting scenario. */
export async function deleteAccountFixture(userId: string) {
  const { systemClient } = await import("./worker");
  const result = await systemClient().auth.admin.deleteUser(userId);
  if (result.error) throw result.error;
}
