import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, listCompanyFilingFrequencies } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";
import { FilingFrequencyForm } from "./filing-frequency-form";

function firstOfCurrentMonth() {
  return `${new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date()).slice(0, 7)}-01`;
}

export default async function FilingFrequencySetupPage({ params }: PageProps<"/companies/[companyId]/setup/filing-frequency">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, history, t] = await Promise.all([
    getCompany(client, companyId),
    listCompanyFilingFrequencies(client, companyId),
    getTranslations("company"),
  ]);
  if (!company) notFound();
  const current = history.at(-1);
  return <main className="company-workspace">
    <header className="company-page-header"><h1>{t("filingFrequencyTitle")}</h1><p>{t("filingSetupIntro")}</p></header>
    <section className="panel company-setup-panel">
      <FilingFrequencyForm companyId={companyId} initialValues={{
        filingFrequency: current?.frequency ?? "monthly",
        filingFrequencyEffectiveFrom: current?.effectiveFrom ?? firstOfCurrentMonth(),
      }} />
    </section>
  </main>;
}
