import { notFound, redirect } from "next/navigation";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";

export default async function CompanyMembersPage({ params }: PageProps<"/companies/[companyId]/members">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role] = await Promise.all([getCompany(client, companyId), getMyCompanyRole(client, companyId)]);
  if (!company) notFound();
  if (role !== "administrator") redirect(`/companies/${company.id}/settings`);
  redirect(`/companies/${company.id}/settings/users`);
}
