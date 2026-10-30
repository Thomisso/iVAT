import type { AppClient } from "./client";

export type MembershipRole = "administrator" | "user";
export type OrganizationSummary = { id: string; name: string; role: MembershipRole };

/** Organizations administered through Membership or MFA-verified platform authority. */
export async function listMyOrganizations(client: AppClient): Promise<OrganizationSummary[]> {
  const { data, error } = await client.rpc("list_organization_administrations");
  if (error?.code === "42501") return [];
  if (error) throw error;
  return (data as unknown as OrganizationSummary[]).map(({ id, name, role }) => ({ id, name, role }));
}
