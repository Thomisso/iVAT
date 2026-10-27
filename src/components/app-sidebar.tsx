import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { logOutAction } from "@/app/actions";
import { getCompany, listMyCompanies } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";
import { Sidebar, type SidebarItem } from "./sidebar";
import { Icon } from "./icon";
import { Button } from "./button";
import { LanguageSwitcher } from "./language-switcher";

export async function AppSidebar({
  currentCompanyId,
  activeDirection,
  activeReport = false,
}: {
  currentCompanyId?: string;
  activeDirection?: "incoming" | "outgoing";
  activeReport?: boolean;
}) {
  const client = await requireUserClient();
  const [companies, current, t] = await Promise.all([
    listMyCompanies(client),
    currentCompanyId ? getCompany(client, currentCompanyId) : null,
    getTranslations(),
  ]);
  const items: SidebarItem[] = currentCompanyId
    ? [
        { group: t("documents.title") },
        {
          label: t("nav.allDocuments"),
          icon: "inbox",
          href: `/companies/${currentCompanyId}`,
          current: !activeDirection && !activeReport,
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
          <LanguageSwitcher />
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
