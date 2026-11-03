import { redirect } from "next/navigation";

export default async function OrganizationMembersPage({ params }: PageProps<"/organizations/[organizationId]/members">) {
  const { organizationId } = await params;
  redirect(`/organizations/${organizationId}/users`);
}
