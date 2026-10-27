import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import { listMemberships } from "@/application/memberships";
import { AppSidebar } from "@/components/app-sidebar";
import { MemberManagement } from "@/components/member-management";
import { requireUserClient } from "@/lib/supabase/server";

export default async function CompanyMembersPage({ params }: PageProps<"/companies/[companyId]/members">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role] = await Promise.all([getCompany(client, companyId), getMyCompanyRole(client, companyId)]);
  if (!company) notFound();
  if (role !== "administrator") redirect(`/companies/${company.id}`);
  const [memberships, t] = await Promise.all([
    listMemberships(client, { organizationId: company.organizationId, companyId: company.id }),
    getTranslations("members"),
  ]);
  return (
    <>
      <AppSidebar currentCompanyId={company.id} activeMembers />
      <main className="dashboard">
        <header><h1>{t("companyTitle", { company: company.name })}</h1></header>
        <MemberManagement organizationId={company.organizationId} companyId={company.id} memberships={memberships} />
      </main>
    </>
  );
}
