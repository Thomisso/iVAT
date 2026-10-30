import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany } from "@/application/companies";
import { listReportingPeriods } from "@/application/reporting-period-readiness";
import { requireUserClient } from "@/lib/supabase/server";
import { StatusBadge } from "@/components/status-badge";
import { PageLayout } from "@/components/app-shell";
import { formatDateTime } from "@/lib/format-date";

export default async function VatPage({ params }: PageProps<"/companies/[companyId]/vat">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, periods, t] = await Promise.all([
    getCompany(client, companyId),
    listReportingPeriods(client, companyId),
    getTranslations("vatReports"),
  ]);
  if (!company) notFound();
  return <PageLayout className="company-workspace vat-periods-workspace" measure="wide">
    <header className="company-page-header">
      <h1>{t("periodsTitle")}</h1>
      <p>{t("periodsDescription")}</p>
    </header>
    <section aria-labelledby="reporting-periods-title" className="vat-period-list">
      <header>
        <div><h2 id="reporting-periods-title">{t("periodsListTitle")}</h2><p>{t("periodsListHint")}</p></div>
        <span>{t("periodCount", { count: periods.length })}</span>
      </header>
      <ol>{periods.toReversed().map((period) => <li className={period.oldestUnfinished ? "is-oldest-unfinished" : ""} key={period.period}>
        <div>
          <strong>{period.period}</strong>
          <small>{t(`frequency.${period.frequency}`)}</small>
        </div>
        <div className="vat-period-state">
          {period.state === "finalized" ? <StatusBadge status="locked">{t("periodState.finalized")}</StatusBadge> : period.state === "draft" ? <StatusBadge status="approved">{t("periodState.draft")}</StatusBadge> : <StatusBadge status="needs-review">{t("periodState.unfinished")}</StatusBadge>}
          {period.oldestUnfinished && <span className="vat-oldest-label">{t("oldestUnfinished")}</span>}
          <small>{period.lockedAt
            ? t("finalizedAt", { date: formatDateTime(period.lockedAt) })
            : period.generatedAt
              ? t("generatedAt", { date: formatDateTime(period.generatedAt) })
              : t("notStarted")}</small>
        </div>
        <Link href={`/companies/${companyId}/vat-reports?period=${period.period}`}>{t("openPeriod")}</Link>
      </li>)}</ol>
    </section>
  </PageLayout>;
}
