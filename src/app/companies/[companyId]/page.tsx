import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { getCompany, getCompanySetupChecklist } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";
import { Icon } from "@/components/icon";

export default async function CompanyOverviewPage({ params }: PageProps<"/companies/[companyId]">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, checklist, t] = await Promise.all([
    getCompany(client, companyId),
    getCompanySetupChecklist(client, companyId),
    getTranslations("shell"),
  ]);
  if (!company) notFound();
  return <main className="company-workspace">
    <header className="company-page-header"><h1>{t("overviewTitle")}</h1><p>{t("overviewDescription", { company: company.name })}</p></header>
    <section aria-labelledby="setup-checklist-title" className="company-setup-checklist">
      <header><h2 id="setup-checklist-title">{t("setupChecklist")}</h2><p>{t("setupChecklistIntro")}</p></header>
      <ol>{checklist.map((item) => {
        const href = item.step === "filing_frequency"
          ? `/companies/${companyId}/setup/filing-frequency`
          : item.step === "identity" ? `/companies/${companyId}/settings` : `/companies/${companyId}/settings`;
        return <li data-state={item.state} key={item.step}>
          <span aria-hidden="true"><Icon name={item.state === "completed" ? "check" : item.state === "blocking" ? "alert" : "info"} /></span>
          <div><strong>{t(`setupStep.${item.step}`)}</strong><small>{t(`setupState.${item.state}`)}</small></div>
          <Link href={href}>{t("setupOpen")}</Link>
        </li>;
      })}</ol>
    </section>
  </main>;
}
