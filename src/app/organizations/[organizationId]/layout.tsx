import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { currentUser } from "@/application/auth";
import { resolveCompanyContext } from "@/application/company-context";
import { OrganizationShell } from "@/components/organization-shell";
import { loadAdministrationAccess } from "@/lib/administration-access";
import { companyContextCookie, parseCompanyContext } from "@/lib/company-context";
import { requireUserClient } from "@/lib/supabase/server";

export default async function OrganizationLayout({ children, params }: LayoutProps<"/organizations/[organizationId]">) {
  const { organizationId } = await params;
  const client = await requireUserClient();
  const remembered = parseCompanyContext((await cookies()).get(companyContextCookie)?.value);
  const [{ organizations, superAdmin }, auth, companyContext] = await Promise.all([
    loadAdministrationAccess(),
    currentUser(client),
    resolveCompanyContext(client, remembered),
  ]);
  const authorizedOrganizations = organizations.filter((organization) => organization.role === "administrator");
  const organization = authorizedOrganizations.find((item) => item.id === organizationId);
  if (!organization || !auth) notFound();

  return <OrganizationShell
    companyHref={companyContext.kind === "company" ? `/companies/${companyContext.companyId}` : "/"}
    email={auth.email}
    organization={organization}
    organizations={authorizedOrganizations}
    superAdmin={superAdmin}
  >{children}</OrganizationShell>;
}
