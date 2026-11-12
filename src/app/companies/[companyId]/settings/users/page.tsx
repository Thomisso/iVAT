import { notFound, redirect } from "next/navigation";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import { ScopedMemberManagement } from "@/components/scoped-member-management";
import { requireUserClient } from "@/lib/supabase/server";

export default async function CompanyUsersSettingsPage({ params, searchParams }: PageProps<"/companies/[companyId]/settings/users">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role] = await Promise.all([getCompany(client, companyId), getMyCompanyRole(client, companyId)]);
  if (!company) notFound();
  if (role !== "administrator") redirect(`/companies/${company.id}/settings`);
  return <ScopedMemberManagement organizationId={company.organizationId} initialCompanyId={companyId} requestedScope={(await searchParams).scope} requestedEmail={(await searchParams).email} />;
}
