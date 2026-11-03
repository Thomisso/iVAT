import { notFound } from "next/navigation";
import { getPlatformCompanyHistory } from "@/application/platform-company-history";
import { PageContent, PageLayout } from "@/components/app-shell";
import { ScopedMemberManagement } from "@/components/scoped-member-management";
import { requireUserClient } from "@/lib/supabase/server";

export default async function PlatformCompanyMembersPage({ params, searchParams }: PageProps<"/platform/companies/[companyId]/members">) {
  const { companyId } = await params;
  const history = await getPlatformCompanyHistory(await requireUserClient(), companyId);
  if (!history.ok || history.value.deletedAt) notFound();
  return <PageLayout measure="wide"><PageContent measure="wide">
    <ScopedMemberManagement headingLevel={1} organizationId={history.value.snapshot.company.organizationId} initialCompanyId={companyId} requestedScope={(await searchParams).scope} />
  </PageContent></PageLayout>;
}
