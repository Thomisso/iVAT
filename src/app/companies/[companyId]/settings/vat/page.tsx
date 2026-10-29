import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { getCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { epoIdentityFindings, getCompany, getMyCompanyRole } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";
import { FilingDefaultsForm } from "../filing-defaults-form";

export default async function VatSettingsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role, defaults, allowance, t, ai] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    getCompanyFilingDefaults(client, companyId),
    getCompanyAiProcessingAllowance(client, companyId),
    getTranslations("company"),
    getTranslations("aiProcessing"),
  ]);
  if (!company) notFound();
  if (role !== "administrator") redirect(`/companies/${company.id}/settings`);

  return <>
    <section className="company-settings-section">
      <header><h2>{t("filingFrequencyTitle")}</h2><p>{t("filingScheduleIntro")}</p></header>
      <Link href={`/companies/${company.id}/setup/filing-frequency`}>{t("editFilingFrequency")}</Link>
    </section>
    <section className="company-settings-section" id="filing-defaults">
      <header><h2>{t("filingDefaultsTitle")}</h2><p>{t("filingDefaultsIntro")}</p></header>
      <FilingDefaultsForm companyId={company.id} defaults={defaults} personType={company.personType} epoOverrideRequired={epoIdentityFindings(company).length > 0} />
    </section>
    {allowance.ok && <section className="company-settings-section">
      <header><h2>{ai("title")}</h2><p>{t("aiProcessingManagedIntro")}</p></header>
      <p>{ai("allowanceUsage", { used: allowance.value.used, allowance: allowance.value.allowance ?? ai("unlimited") })}</p>
      <p className="iv-muted">{ai("waitingDocuments", { count: allowance.value.waitingDocuments })}</p>
    </section>}
  </>;
}
