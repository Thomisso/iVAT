import { configuredInvitationUrls } from "@/lib/invitations";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import { listCompanyAccess, listPendingInvitations } from "@/application/memberships";
import { MemberManagement } from "@/components/member-management";
import { requireUserClient } from "@/lib/supabase/server";

export default async function CompanyUsersSettingsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const urls = configuredInvitationUrls();
  const [company, role] = await Promise.all([getCompany(client, companyId), getMyCompanyRole(client, companyId)]);
  if (!company) notFound();
  if (role !== "administrator") redirect(`/companies/${company.id}/settings`);
  const [companyAccess, pendingInvitations, t] = await Promise.all([
    listCompanyAccess(client, company.id),
    listPendingInvitations(client, { organizationId: company.organizationId, companyId: company.id }),
    getTranslations("members"),
  ]);
  if (!companyAccess.ok) redirect(`/companies/${company.id}/settings`);

  return <section className="company-settings-section company-settings-users">
    <header><h2>{t("companyTitle", { company: company.name })}</h2></header>
    <MemberManagement acceptUrl={urls.ok ? urls.value.acceptUrl : null} organizationId={company.organizationId} companyId={company.id} companyAccess={companyAccess.value} pendingInvitations={pendingInvitations} />
  </section>;
}
