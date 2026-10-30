import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { listMemberships, listPendingInvitations } from "@/application/memberships";
import { listMyOrganizations } from "@/application/organizations";
import { PageContent, PageHeader, PageLayout } from "@/components/app-shell";
import { MemberManagement } from "@/components/member-management";
import { requireUserClient } from "@/lib/supabase/server";

export default async function OrganizationMembersPage({ params }: PageProps<"/organizations/[organizationId]/members">) {
  const { organizationId } = await params;
  const client = await requireUserClient();
  const organization = (await listMyOrganizations(client)).find((item) => item.id === organizationId && item.role === "administrator");
  if (!organization) notFound();
  const [memberships, pendingInvitations, t] = await Promise.all([
    listMemberships(client, { organizationId, companyId: null }),
    listPendingInvitations(client, { organizationId, companyId: null }),
    getTranslations("members"),
  ]);
  return <PageLayout className="organization-members" measure="wide">
    <PageHeader title={t("organizationTitle", { organization: organization.name })} />
    <PageContent measure="wide">
        <MemberManagement
          organizationId={organizationId}
          companyId={null}
          memberships={memberships}
          pendingInvitations={pendingInvitations}
        />
    </PageContent>
  </PageLayout>;
}
