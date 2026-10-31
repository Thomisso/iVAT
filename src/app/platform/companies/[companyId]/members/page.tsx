import { configuredInvitationUrls } from "@/lib/invitations";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getPlatformCompanyHistory } from "@/application/platform-company-history";
import { listCompanyAccess, listPendingInvitations } from "@/application/memberships";
import { PageContent, PageHeader, PageLayout } from "@/components/app-shell";
import { MemberManagement } from "@/components/member-management";
import { Notice } from "@/components/notice";
import { requireUserClient } from "@/lib/supabase/server";

export default async function PlatformCompanyMembersPage({ params }: PageProps<"/platform/companies/[companyId]/members">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const urls = configuredInvitationUrls();
  const history = await getPlatformCompanyHistory(client, companyId);
  if (!history.ok || history.value.deletedAt) notFound();
  const { company } = history.value.snapshot;
  const [access, invitations, members, support] = await Promise.all([
    listCompanyAccess(client, companyId),
    listPendingInvitations(client, { organizationId: company.organizationId, companyId }),
    getTranslations("members"), getTranslations("platformHistory"),
  ]);
  if (!access.ok) notFound();
  return <PageLayout measure="wide">
    <PageHeader title={members("companyTitle", { company: company.name })} />
    <PageContent measure="wide">
      {history.value.blocked && <Notice tone="warning">{support("blockedNotice")}</Notice>}
      <MemberManagement acceptUrl={urls.ok ? urls.value.acceptUrl : null} organizationId={company.organizationId} companyId={companyId}
        companyAccess={access.value} pendingInvitations={invitations} />
    </PageContent>
  </PageLayout>;
}
