import { notFound } from "next/navigation";
import { getCompany, getMyCompanyRole, listMyCompanies } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { isSuperAdmin } from "@/application/platform-ai";
import { currentUser } from "@/application/auth";
import { listUploadNotifications } from "@/application/upload-batches";
import { CompanyShell } from "@/components/company-shell";
import { requireUserClient } from "@/lib/supabase/server";

export default async function CompanyLayout({ children, params }: LayoutProps<"/companies/[companyId]">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, companies, companyRole, organizations, superAdmin, auth, uploadNotifications] = await Promise.all([
    getCompany(client, companyId),
    listMyCompanies(client),
    getMyCompanyRole(client, companyId),
    listMyOrganizations(client),
    isSuperAdmin(client),
    currentUser(client),
    listUploadNotifications(client, companyId, { unreadOnly: true, limit: 3 }),
  ]);
  if (!company || !auth) notFound();
  return <CompanyShell
    companies={companies}
    company={company}
    companyRole={companyRole}
    email={auth.email}
    organizations={organizations}
    superAdmin={superAdmin}
    uploadNotifications={uploadNotifications}
  >{children}</CompanyShell>;
}
