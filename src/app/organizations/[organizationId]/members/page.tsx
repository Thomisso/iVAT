import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { listMemberships } from "@/application/memberships";
import { listMyOrganizations } from "@/application/organizations";
import { AppSidebar } from "@/components/app-sidebar";
import { MemberManagement } from "@/components/member-management";
import { requireUserClient } from "@/lib/supabase/server";

export default async function OrganizationMembersPage({ params }: PageProps<"/organizations/[organizationId]/members">) {
  const { organizationId } = await params;
  const client = await requireUserClient();
  const organization = (await listMyOrganizations(client)).find((item) => item.id === organizationId && item.role === "administrator");
  if (!organization) notFound();
  const [memberships, t] = await Promise.all([
    listMemberships(client, { organizationId, companyId: null }),
    getTranslations("members"),
  ]);
  return (
    <>
      <AppSidebar />
      <main className="dashboard">
        <header><h1>{t("organizationTitle", { organization: organization.name })}</h1></header>
        <MemberManagement organizationId={organizationId} companyId={null} memberships={memberships} />
      </main>
    </>
  );
}
