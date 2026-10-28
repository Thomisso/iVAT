import { notFound } from "next/navigation";
import { getCompany, getMyCompanyRole, listMyCompanies } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { isSuperAdmin } from "@/application/platform-ai";
import { currentUser } from "@/application/auth";
import { CompanyShell } from "@/components/company-shell";
import { requireUserClient } from "@/lib/supabase/server";

export default async function CompanyLayout({ children, params }: LayoutProps<"/companies/[companyId]">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, companies, companyRole, organizations, superAdmin, auth] = await Promise.all([
    getCompany(client, companyId),
    listMyCompanies(client),
    getMyCompanyRole(client, companyId),
    listMyOrganizations(client),
    isSuperAdmin(client),
    currentUser(client),
  ]);
  if (!company || !auth) notFound();
  return <CompanyShell
    companies={companies}
    company={company}
    companyRole={companyRole}
    email={auth.email}
    organizations={organizations}
    superAdmin={superAdmin}
  >{children}</CompanyShell>;
}
