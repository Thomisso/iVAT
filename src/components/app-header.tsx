import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { logOutAction } from "@/app/actions";
import { listMyCompanies } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";
import { LanguageSwitcher } from "./language-switcher";

export async function AppHeader({ currentCompanyId }: { currentCompanyId?: string }) {
  const client = await requireUserClient();
  const companies = await listMyCompanies(client);
  const t = await getTranslations();
  return (
    <header className="app-header">
      <Link href="/" className="brand">
        {t("app.name")}
      </Link>
      <nav aria-label={t("dashboard.companies")}>
        {companies.map((company) => (
          <Link
            key={company.id}
            href={`/companies/${company.id}`}
            aria-current={company.id === currentCompanyId ? "page" : undefined}
          >
            {company.name}
          </Link>
        ))}
        <Link href="/companies/new">+ {t("nav.addCompany")}</Link>
      </nav>
      <LanguageSwitcher />
      <form action={logOutAction}>
        <button type="submit">{t("nav.logOut")}</button>
      </form>
    </header>
  );
}
