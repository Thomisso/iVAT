import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, getMyCompanyRole, listCompanyFilingFrequencies } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";
import { FilingFrequencyForm } from "./filing-frequency-form";
import { PageLayout } from "@/components/app-shell";

function firstOfCurrentMonth() {
  return `${new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date()).slice(0, 7)}-01`;
}

export default async function FilingFrequencySetupPage({ params }: PageProps<"/companies/[companyId]/setup/filing-frequency">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role, history, t] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    listCompanyFilingFrequencies(client, companyId),
    getTranslations("company"),
  ]);
  if (!company) notFound();
  if (role !== "administrator") redirect(`/companies/${company.id}/settings`);
  const current = history.at(-1);
  return <PageLayout className="company-workspace" measure="narrow">
    <header className="company-page-header"><h1>{t("filingFrequencyTitle")}</h1><p>{t("filingSetupIntro")}</p></header>
    <section className="panel company-setup-panel">
      <FilingFrequencyForm companyId={companyId} initialValues={{
        filingFrequency: current?.frequency ?? "monthly",
        filingFrequencyEffectiveFrom: current?.effectiveFrom ?? firstOfCurrentMonth(),
      }} />
    </section>
  </PageLayout>;
}
