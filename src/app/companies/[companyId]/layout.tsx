import { notFound } from "next/navigation";
import { getCompany, getMyCompanyRole, listMyCompanies } from "@/application/companies";
import { currentUser } from "@/application/auth";
import { countUnreadUploadNotifications, listUploadNotifications } from "@/application/upload-batches";
import { CompanyShell } from "@/components/company-shell";
import { loadAdministrationAccess } from "@/lib/administration-access";
import { availableAuthValue, requireUserClient } from "@/lib/supabase/server";

export default async function CompanyLayout({ children, params }: LayoutProps<"/companies/[companyId]">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, companies, companyRole, { superAdmin }, auth, uploadNotifications, uploadUnreadCount] = await Promise.all([
    getCompany(client, companyId),
    listMyCompanies(client),
    getMyCompanyRole(client, companyId),
    loadAdministrationAccess(),
    currentUser(client).then(availableAuthValue),
    listUploadNotifications(client, companyId),
    countUnreadUploadNotifications(client, companyId),
  ]);
  if (!company || !auth) notFound();
  return <CompanyShell
    companies={companies}
    company={company}
    companyRole={companyRole}
    email={auth.email}
    superAdmin={superAdmin}
    uploadNotifications={uploadNotifications}
    uploadUnreadCount={uploadUnreadCount}
  >{children}</CompanyShell>;
}
