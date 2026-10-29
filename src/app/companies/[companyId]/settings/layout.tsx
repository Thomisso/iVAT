import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import { PageLayout } from "@/components/app-shell";
import { requireUserClient } from "@/lib/supabase/server";
import { SettingsNavigation } from "./settings-navigation";

export default async function CompanySettingsLayout({ children, params }: LayoutProps<"/companies/[companyId]/settings">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role, t] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    getTranslations("company"),
  ]);
  if (!company) notFound();

  return <PageLayout className="company-workspace company-settings" measure="wide">
    <header className="company-page-header">
      <h1>{t("settingsTitle")}</h1>
      <p>{t("settingsIntro")}</p>
    </header>
    <SettingsNavigation companyId={company.id} administrator={role === "administrator"} />
    <div className="company-settings-content">{children}</div>
  </PageLayout>;
}
