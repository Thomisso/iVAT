import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, getMyCompanyRole, listCompanyReportingYears } from "@/application/companies";
import { currentReportingYear } from "@/application/reporting-periods";
import { requireUserClient } from "@/lib/supabase/server";
import { FilingFrequencyForm } from "./filing-frequency-form";
import { PageLayout } from "@/components/app-shell";

export default async function FilingFrequencySetupPage({ params }: PageProps<"/companies/[companyId]/setup/filing-frequency">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role, reportingYears, t] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    listCompanyReportingYears(client, companyId),
    getTranslations("company"),
  ]);
  if (!company) notFound();
  if (role !== "administrator") redirect(`/companies/${company.id}/settings`);
  const year = currentReportingYear();
  const current = reportingYears.find((reportingYear) => reportingYear.year === year);
  return <PageLayout className="company-workspace" measure="narrow">
    <header className="company-page-header"><h1>{t("filingFrequencyTitle")}</h1><p>{t("filingSetupIntro")}</p></header>
    <section className="panel company-setup-panel">
      <FilingFrequencyForm companyId={companyId} year={year} initialValues={{
        filingFrequency: current?.frequency ?? "monthly",
      }} />
    </section>
  </PageLayout>;
}
