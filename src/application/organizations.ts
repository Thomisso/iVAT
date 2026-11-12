import type { AppClient, Result } from "./client";

export type MembershipRole = "administrator" | "user";
export type OrganizationSummary = { id: string; name: string; role: MembershipRole };

/** Organizations administered through Membership or MFA-verified platform authority. */
export async function listMyOrganizations(client: AppClient): Promise<OrganizationSummary[]> {
  const { data, error } = await client.rpc("list_organization_administrations");
  if (error?.code === "42501") return [];
  if (error) throw error;
  return (data as unknown as OrganizationSummary[]).map(({ id, name, role }) => ({ id, name, role }));
}

/** Creates an empty tenant through the database's MFA-verified platform authority. */
export async function createOrganization(
  client: AppClient,
  input: { name: string },
): Promise<Result<{ id: string; name: string }, "forbidden" | "organization_name_required">> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "organization_name_required" };
  const { data, error } = await client.rpc("create_organization", { organization_name: name });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.hint === "organization_name_required") return { ok: false, error: "organization_name_required" };
    throw error;
  }
  return { ok: true, value: { id: data, name } };
}
