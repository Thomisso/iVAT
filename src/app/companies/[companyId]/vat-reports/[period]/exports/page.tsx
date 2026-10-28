import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany } from "@/application/companies";
import { getVatReport } from "@/application/vat-reports";
import { requireUserClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/empty-state";
import { PeriodNavigation } from "../../period-navigation";

export default async function ExportHistoryPage({
  params,
}: PageProps<"/companies/[companyId]/vat-reports/[period]/exports">) {
  const { companyId, period } = await params;
  const client = await requireUserClient();
  const [company, report, t] = await Promise.all([
    getCompany(client, companyId),
    getVatReport(client, companyId, period),
    getTranslations("vatReports"),
  ]);
  if (!company || !report) notFound();
  return (
    <main className="company-workspace vat-reports vat-output-page">
      <header className="company-page-header vat-report-header">
        <p>
          <Link href={`/companies/${companyId}/vat`}>
            {t("backToPeriods")}
          </Link>
        </p>
        <span className="vat-output-context">
          {company.name} · {period}
        </span>
        <h1>{t("exportHistoryTitle", { period })}</h1>
        <p>{t("exportHistoryDescription")}</p>
      </header>
      <PeriodNavigation
        active="exportHistory"
        companyId={companyId}
        period={period}
        reportAvailable
      />
      <section className="vat-export-history">
        <EmptyState icon="report" title={t("noExportArtifacts")} />
        <p>{t("noExportArtifactsHint")}</p>
        <div>
          <Link href={`/companies/${companyId}/vat-reports/${period}/vat-return`}>
            {t("openVatReturn")}
          </Link>
          <Link href={`/companies/${companyId}/vat-reports/${period}/control-statement`}>
            {t("openControlStatement")}
          </Link>
        </div>
      </section>
    </main>
  );
}
