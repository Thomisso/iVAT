import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import { SettingsPageLayout } from "@/components/app-shell";
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
  if (role !== "administrator") redirect(`/companies/${company.id}`);

  return <SettingsPageLayout title={t("settingsTitle")} description={t("settingsIntro")}
    navigation={<SettingsNavigation companyId={company.id} administrator={role === "administrator"} />}
  >{children}</SettingsPageLayout>;
}
