import Link from "next/link";
import { Fragment } from "react";
import { getTranslations } from "next-intl/server";
import { logOutAction } from "@/app/actions";
import { getCompany, getMyCompanyRole, listMyCompanies } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { isSuperAdmin } from "@/application/platform-ai";
import { requireUserClient } from "@/lib/supabase/server";
import { Sidebar, type SidebarItem } from "./sidebar";
import { Icon } from "./icon";
import { Button } from "./button";
import { LanguageSwitcher } from "./language-switcher";

export async function AppSidebar({
  currentCompanyId,
  activeDirection,
  activeReport = false,
  activeMembers = false,
}: {
  currentCompanyId?: string;
  activeDirection?: "incoming" | "outgoing";
  activeReport?: boolean;
  activeMembers?: boolean;
}) {
  const client = await requireUserClient();
  const [companies, current, role, organizations, superAdmin, t] = await Promise.all([
    listMyCompanies(client),
    currentCompanyId ? getCompany(client, currentCompanyId) : null,
    currentCompanyId ? getMyCompanyRole(client, currentCompanyId) : null,
    listMyOrganizations(client),
    isSuperAdmin(client),
    getTranslations(),
  ]);
  const items: SidebarItem[] = currentCompanyId
    ? [
        { group: t("documents.title") },
        {
          label: t("nav.allDocuments"),
          icon: "inbox",
          href: `/companies/${currentCompanyId}`,
          current: !activeDirection && !activeReport && !activeMembers,
        },
        {
          label: t("nav.received"),
          icon: "inbox",
          href: `/companies/${currentCompanyId}?direction=incoming`,
          current: activeDirection === "incoming",
        },
        {
          label: t("nav.issued"),
          icon: "send",
          href: `/companies/${currentCompanyId}?direction=outgoing`,
          current: activeDirection === "outgoing",
        },
        { group: t("vatReports.title") },
        {
          label: t("vatReports.title"),
          icon: "report",
          href: `/companies/${currentCompanyId}/vat-reports`,
          current: activeReport,
        },
        ...(role === "administrator" ? [{
          label: t("members.nav"),
          icon: "building" as const,
          href: `/companies/${currentCompanyId}/members`,
          current: activeMembers,
        }] : []),
      ]
    : [];
  return (
    <Sidebar
      company={current ?? undefined}
      items={items}
      companySwitcher={
        <details className="company-switcher">
          <summary className="iv-company">
            <Icon name="building" />
            <span className="iv-company-text">
              <span className="iv-company-name">
                {current?.name ?? t("nav.switchCompany")}
              </span>
              {current && (
                <span className="iv-company-id">
                  {t("company.ico")} {current.ico}
                </span>
              )}
            </span>
            <Icon name="chevron" />
          </summary>
          <nav className="iv-nav" aria-label={t("nav.switchCompany")}>
            {companies.map((company) => (
              <Link
                key={company.id}
                href={`/companies/${company.id}`}
                className="iv-nav-item"
                aria-current={
                  company.id === currentCompanyId ? "page" : undefined
                }
              >
                {company.name}
              </Link>
            ))}
            <Link href="/companies/new" className="iv-nav-item">
              <Icon name="building" />
              {t("nav.addCompany")}
            </Link>
          </nav>
        </details>
      }
      userMenu={
        <details>
          <summary>{t("nav.userMenu")}</summary>
          {organizations.map((organization) => (
            <Fragment key={organization.id}>
              <Link href={`/organizations/${organization.id}/members`}>
                {t("members.organizationNav", { organization: organization.name })}
              </Link>
              {organization.role === "administrator" && (
                <>
                  <Link href={`/organizations/${organization.id}/ai-settings`}>
                    {t("organizationAi.nav", { organization: organization.name })}
                  </Link>
                  <Link href={`/organizations/${organization.id}/ai-usage`}>
                    {t("aiUsage.organizationNav", { organization: organization.name })}
                  </Link>
                  <Link href={`/organizations/${organization.id}/audit-log`}>
                    {t("auditLog.organizationNav", { organization: organization.name })}
                  </Link>
                </>
              )}
            </Fragment>
          ))}
          {superAdmin && <Link href="/platform/ai-settings">{t("platformAi.nav")}</Link>}
          {superAdmin && <Link href="/platform/ai-usage">{t("aiUsage.platformNav")}</Link>}
          {superAdmin && <Link href="/platform/administration">{t("platformAdministration.nav")}</Link>}
          <LanguageSwitcher />
          <Link href="/settings/security">{t("nav.security")}</Link>
          <form action={logOutAction}>
            <Button type="submit" variant="ghost">
              {t("nav.logOut")}
            </Button>
          </form>
        </details>
      }
    />
  );
}
