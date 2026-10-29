import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany } from "@/application/companies";
import { getCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { getPeriodLock, getVatReport } from "@/application/vat-reports";
import { requireUserClient } from "@/lib/supabase/server";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { formatDocumentDate } from "@/lib/format-date";
import { ExportForm } from "../../export-form";
import { PeriodNavigation } from "../../period-navigation";
import { ReportAmount, ReportIssues } from "../../report-output";

export async function generateMetadata({
  params,
}: PageProps<"/companies/[companyId]/vat-reports/[period]/control-statement">): Promise<Metadata> {
  const { period } = await params;
  const t = await getTranslations("vatReports");
  return { title: t("controlStatementTitle", { period }) };
}

export default async function ControlStatementPage({
  params,
}: PageProps<"/companies/[companyId]/vat-reports/[period]/control-statement">) {
  const { companyId, period } = await params;
  const client = await requireUserClient();
  const [company, filingDefaults, report, periodLock, readinessResult, t] = await Promise.all([
    getCompany(client, companyId),
    getCompanyFilingDefaults(client, companyId),
    getVatReport(client, companyId, period),
    getPeriodLock(client, companyId, period),
    getReportingPeriodReadiness(client, { companyId, period }),
    getTranslations("vatReports"),
  ]);
  if (!company || !report || !readinessResult.ok) notFound();
  const readiness = readinessResult.value;
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
        <div className="vat-output-title-row">
          <div>
            <h1>{t("controlStatementTitle", { period })}</h1>
            <p>{t("controlStatementDescription")}</p>
          </div>
          {periodLock && <StatusBadge status="locked" />}
        </div>
      </header>
      <PeriodNavigation
        active="controlStatement"
        companyId={companyId}
        period={period}
        reportAvailable
      />
      <section className="vat-snapshot-summary">
        <span className="vat-section-label">{t("savedSnapshot")}</span>
        <h2>{t("snapshotFrom", { date: formatDocumentDate(report.generatedAt, true) })}</h2>
        <p>{t(`snapshotFreshness.${readiness.snapshot?.freshness ?? "stale"}`)}</p>
      </section>
      <section className="vat-statutory-output">
        <h2>{t("controlStatement")}</h2>
        <p>{t("controlStatementHint", { count: report.result.controlStatement.length })}</p>
        {report.result.controlStatement.length === 0 ? (
          <p>{t("noEntries")}</p>
        ) : (
          report.result.controlStatement.map((entry, index) => (
            <div className="report-section" key={`${entry.section}-${index}`}>
              <h3>{t("section", { section: entry.section })}</h3>
              {entry.documentNumber && (
                <p>
                  {entry.documentNumber} · {entry.counterpartyVatId} ·{" "}
                  {formatDocumentDate(entry.taxPointDate!)}
                  {entry.reverseChargeCode && (
                    <>
                      {" "}· {t("reverseChargeCode")} {entry.reverseChargeCode}
                    </>
                  )}
                </p>
              )}
              <DataTable
                caption={t("section", { section: entry.section })}
                rows={entry.rateBreakdown.map((rate) => ({
                  ...rate,
                  id: String(rate.rate),
                }))}
                columns={[
                  {
                    key: "rate",
                    header: t("rateLabel"),
                    render: (rate) => t("rate", { rate: rate.rate }),
                  },
                  {
                    key: "netAmount",
                    header: t("netAmount"),
                    align: "right",
                    render: (rate) => (
                      <ReportAmount
                        amount={rate.netAmount}
                        companyId={companyId}
                        documentIds={rate.documentIds}
                        documents={report.documents}
                      />
                    ),
                  },
                  {
                    key: "vatAmount",
                    header: t("vatAmount"),
                    align: "right",
                    render: (rate) => (
                      <ReportAmount
                        amount={rate.vatAmount}
                        companyId={companyId}
                        documentIds={rate.documentIds}
                        documents={report.documents}
                      />
                    ),
                  },
                ]}
              />
            </div>
          ))
        )}
      </section>
      <ReportIssues companyId={companyId} readiness={readiness} report={report} />
      <section className="vat-output-actions">
        <h2>{t("controlStatementActions")}</h2>
        <div className="vat-output-action-grid is-single">
          <ExportForm
            companyId={companyId}
            format="dphkh1"
            period={period}
            preparedOn={new Intl.DateTimeFormat("sv-SE", {
              timeZone: "Europe/Prague",
            }).format(new Date())}
            personType={report.result.company.personType}
            defaults={filingDefaults}
          />
        </div>
      </section>
    </main>
  );
}
