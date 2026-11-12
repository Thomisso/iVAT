import { PageContent, PageLayout } from "@/components/app-shell";
import { ScopedMemberManagement } from "@/components/scoped-member-management";

export default async function OrganizationUsersPage({ params, searchParams }: PageProps<"/organizations/[organizationId]/users">) {
  const { organizationId } = await params;
  return <PageLayout measure="wide"><PageContent measure="wide">
    <ScopedMemberManagement headingLevel={1} organizationId={organizationId} initialCompanyId={null} requestedScope={(await searchParams).scope} requestedEmail={(await searchParams).email} />
  </PageContent></PageLayout>;
}
