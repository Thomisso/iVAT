import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { getCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { epoIdentityFindings, getCompany, getMyCompanyRole, listCompanyReportingYears } from "@/application/companies";
import { currentReportingYear } from "@/application/reporting-periods";
import { requireUserClient } from "@/lib/supabase/server";
import { FilingDefaultsForm } from "../filing-defaults-form";
import { ReportingYears } from "../reporting-years";

export default async function VatSettingsPage({ params, searchParams }: PageProps<"/companies/[companyId]/settings/vat">) {
  const { companyId } = await params;
  const { generateYear } = await searchParams;
  const client = await requireUserClient();
  const [company, role, defaults, allowance, reportingYears, t, ai] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    getCompanyFilingDefaults(client, companyId),
    getCompanyAiProcessingAllowance(client, companyId),
    listCompanyReportingYears(client, companyId),
    getTranslations("company"),
    getTranslations("aiProcessing"),
  ]);
  if (!company) notFound();
  if (role !== "administrator") redirect(`/companies/${company.id}/settings`);

  // A Document without a period links here with the year it needs.
  const requestedYear = typeof generateYear === "string" ? Number(generateYear) : NaN;
  const suggestedYear = Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2099
    ? requestedYear
    : (reportingYears.at(-1)?.year ?? currentReportingYear() - 1) + 1;

  return <>
    <section className="company-settings-section" id="reporting-years">
      <header><h2>{t("reportingYearsTitle")}</h2><p>{t("reportingYearsIntro")}</p></header>
      <ReportingYears companyId={company.id} years={reportingYears} suggestedYear={suggestedYear} />
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
