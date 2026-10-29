import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";
import { CompanyDataExportForm } from "../company-data-export-form";
import { CompanyDeletionForm } from "../company-deletion-form";

export default async function CompanyDataSettingsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role, t] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    getTranslations("company"),
  ]);
  if (!company) notFound();
  if (role !== "administrator") redirect(`/companies/${company.id}/settings`);

  return <>
    <header className="company-settings-section-heading"><h2>{t("dataAndDeletion")}</h2><p>{t("dataAndDeletionIntro")}</p></header>
    <CompanyDataExportForm companyId={company.id} />
    <CompanyDeletionForm companyId={company.id} />
  </>;
}
