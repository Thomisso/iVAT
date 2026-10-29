import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, getCompanySetupChecklist, getMyCompanyRole } from "@/application/companies";
import { Icon } from "@/components/icon";
import { requireUserClient } from "@/lib/supabase/server";

export default async function CompanySettingsPage({ params }: PageProps<"/companies/[companyId]/settings">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, checklist, role, shell, t] = await Promise.all([
    getCompany(client, companyId),
    getCompanySetupChecklist(client, companyId),
    getMyCompanyRole(client, companyId),
    getTranslations("shell"),
    getTranslations("company"),
  ]);
  if (!company) notFound();

  const checklistHref = (step: (typeof checklist)[number]["step"]) => {
    if (step === "identity") return `/companies/${companyId}/settings/company`;
    if (step === "filing_frequency") return `/companies/${companyId}/setup/filing-frequency`;
    if (step === "ai_processing") return `/companies/${companyId}/setup/ai-processing`;
    return `/companies/${companyId}/settings/vat`;
  };

  return <>
    {role === "administrator" ? <section aria-labelledby="settings-destinations-title" className="company-settings-destinations">
      <header>
        <h2 id="settings-destinations-title">{t("settingsDestinationsTitle")}</h2>
        <p>{t("settingsDestinationsIntro")}</p>
      </header>
      <div>
        {[
          ["company", "companyDetails", "companyDetailsIntro"],
          ["vat", "vatAndReporting", "vatAndReportingIntro"],
          ["users", "usersTitle", "usersIntro"],
          ["data", "dataAndDeletion", "dataAndDeletionIntro"],
        ].map(([path, title, intro]) => <Link href={`/companies/${companyId}/settings/${path}`} key={path}>
          <strong>{t(title)}</strong>
          <span>{t(intro)}</span>
        </Link>)}
      </div>
    </section> : <p className="iv-muted">{t("administratorSettingsOnly")}</p>}
    <section aria-labelledby="setup-checklist-title" className="company-setup-checklist">
      <header><h2 id="setup-checklist-title">{shell("setupChecklist")}</h2><p>{shell("setupChecklistIntro")}</p></header>
      <ol>{checklist.map((item) => <li data-state={item.state} key={item.step}>
        <span aria-hidden="true"><Icon name={item.state === "completed" ? "check" : item.state === "blocking" ? "alert" : "info"} /></span>
        <div><strong>{shell(`setupStep.${item.step}`)}</strong><small>{shell(`setupState.${item.state}`)}</small></div>
        {role === "administrator" && <Link href={checklistHref(item.step)}>{shell("setupOpen")}</Link>}
      </li>)}</ol>
    </section>
  </>;
}
