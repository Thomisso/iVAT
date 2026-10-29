import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

async function browserFixtureClient() {
  const contents = await fs.readFile(".env.local", "utf8");
  const environment = Object.fromEntries(contents.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  return createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Browser-fixture setup for a user who signed up through the real UI. */
export async function addBrowserCompanyMemberFixture(companyId: string, email: string) {
  const service = await browserFixtureClient();
  const [{ data: company }, { data: users }] = await Promise.all([
    service.from("company").select("organization_id").eq("id", companyId).single(),
    service.auth.admin.listUsers(),
  ]);
  const userId = users.users.find((user) => user.email === email)?.id;
  if (!company || !userId) throw new Error("Could not prepare regular User browser fixture");
  const membership = await service.from("membership").insert({
    company_id: companyId,
    email,
    organization_id: company.organization_id,
    role: "user",
    user_id: userId,
  });
  if (membership.error) throw membership.error;
}

/** Browser-fixture setup for a SuperAdmin who signed up through the real UI. */
export async function promoteBrowserSuperAdminFixture(email: string) {
  const service = await browserFixtureClient();
  const { data: users, error: usersError } = await service.auth.admin.listUsers();
  if (usersError) throw usersError;
  const userId = users.users.find((user) => user.email === email)?.id;
  if (!userId) throw new Error("Could not prepare SuperAdmin browser fixture");
  const promoted = await service.from("platform_user").insert({
    role: "super_admin",
    user_id: userId,
  });
  if (promoted.error) throw promoted.error;
}
