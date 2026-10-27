import type { AppClient } from "./client";

export type MembershipRole = "administrator" | "user";
export type OrganizationSummary = { id: string; name: string; role: MembershipRole };

/** Organizations where the current user holds an Organization-level Membership. */
export async function listMyOrganizations(client: AppClient): Promise<OrganizationSummary[]> {
  const { data, error } = await client
    .from("membership")
    .select("role, organization:organization_id (id, name)")
    .is("company_id", null)
    .order("created_at");
  if (error) throw error;
  return data.map((m) => ({ id: m.organization!.id, name: m.organization!.name, role: m.role }));
}
