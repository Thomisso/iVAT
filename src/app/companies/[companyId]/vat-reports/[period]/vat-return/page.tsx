import { companyPageContext, safeCompanyReturnTo } from "@/application/return-context";
import { CompanyReturnLink } from "@/components/company-return-link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany } from "@/application/companies";
import { getCompanyFilingDefaults, resolveEpoAddress } from "@/application/company-filing-defaults";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { getPeriodLock, getVatReport } from "@/application/vat-reports";
import { vatReturnPreviewData } from "@/application/vat-return-preview";
import { requireUserClient } from "@/lib/supabase/server";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { PageLayout } from "@/components/app-shell";
import { formatDateTime } from "@/lib/format-date";
import { ExportForm } from "../../export-form";
import { PeriodNavigation } from "../../period-navigation";
import { ReportAmount, ReportIssues } from "../../report-output";

export async function generateMetadata({
  params,
}: PageProps<"/companies/[companyId]/vat-reports/[period]/vat-return">): Promise<Metadata> {
  const { period } = await params;
  const t = await getTranslations("vatReports");
  return { title: t("vatReturnTitle", { period }) };
}

export default async function VatReturnPage({
  params, searchParams,
}: PageProps<"/companies/[companyId]/vat-reports/[period]/vat-return">) {
  const { companyId, period } = await params;
  const search = await searchParams;
  const returnTo = safeCompanyReturnTo(companyId, search.returnTo);
  const context = companyPageContext(companyId, `/companies/${companyId}/vat-reports/${period}/vat-return`, search);
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
  const preview = vatReturnPreviewData(report.result);
  const readiness = readinessResult.value;
  const epoAddress = resolveEpoAddress(report.result.company, filingDefaults);
  return (
    <PageLayout className="company-workspace vat-reports vat-output-page" measure="wide">
      <header className="company-page-header vat-report-header">
        <p>
          <CompanyReturnLink companyId={companyId} returnTo={returnTo} fallback={`/companies/${companyId}/vat`} />
        </p>
        <span className="vat-output-context">
          {company.name} · {period}
        </span>
        <div className="vat-output-title-row">
          <div>
            <h1>{t("vatReturnTitle", { period })}</h1>
            <p>{t("vatReturnDescription")}</p>
          </div>
          {periodLock && <StatusBadge status="locked" />}
        </div>
      </header>
      <PeriodNavigation
        returnTo={returnTo}
        active="vatReturn"
        companyId={companyId}
        period={period}
        reportAvailable
      />
      <section className="vat-snapshot-summary">
        <span className="vat-section-label">{t("savedSnapshot")}</span>
        <h2>{t("snapshotFrom", { date: formatDateTime(report.generatedAt) })}</h2>
        <p>{t(`snapshotFreshness.${readiness.snapshot?.freshness ?? "stale"}`)}</p>
      </section>
      <section className="vat-statutory-output">
        <h2>{t("vatReturn")}</h2>
        <p>{t("snapshot")}</p>
        <DataTable
          caption={t("vatReturn")}
          rowId={(line) => `vat-line-${line.line}`}
          rows={preview.lines.map((line) => ({ ...line, id: line.line }))}
          columns={[
            {
              key: "line",
              header: t("line"),
              render: (line) => t(`lines.${line.line}`),
            },
            {
              key: "netAmount",
              header: t("netAmount"),
              align: "right",
              render: (line) => (
                <ReportAmount
                  amount={line.netAmount}
                  companyId={companyId}
                  returnTo={`${context}#vat-line-${line.line}`}
                  documentIds={line.documentIds}
                  documents={report.documents}
                />
              ),
            },
            {
              key: "vatAmount",
              header: t("vatAmount"),
              align: "right",
              render: (line) => (
                <ReportAmount
                  amount={line.vatAmount}
                  companyId={companyId}
                  returnTo={`${context}#vat-line-${line.line}`}
                  documentIds={line.documentIds}
                  documents={report.documents}
                />
              ),
            },
          ]}
        />
        <dl className="report-totals">
          {(
            [
              ["outputVat", report.result.totalDocumentIds.outputVat],
              ["inputVat", report.result.totalDocumentIds.inputVat],
              ["payable", report.result.totalDocumentIds.payable],
              [
                "excessDeduction",
                report.result.totalDocumentIds.excessDeduction,
              ],
            ] as const
          ).map(([key, documentIds]) => (
            <div key={key}>
              <dt>{t(key)}</dt>
              <dd>
                <ReportAmount
                  amount={preview.totals[key]}
                  companyId={companyId}
                  returnTo={context}
                  documentIds={[...documentIds]}
                  documents={report.documents}
                />
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <ReportIssues companyId={companyId} readiness={readiness} report={report} returnTo={`${context}#vat-output-issues`} />
      <section className="vat-output-actions">
        <h2>{t("vatReturnActions")}</h2>
        <div className="vat-output-action-grid">
          <article className="vat-export-card">
            <span className="vat-section-label">{t("pdfFormat")}</span>
            <h3>{t("pdfPreview")}</h3>
            <p>{t("pdfPreviewHint")}</p>
            <a
              className="iv-btn iv-btn-secondary iv-btn-md"
              href={`/companies/${companyId}/vat-reports/${period}/pdf`}
              download={`DPHDP3-${period}.pdf`}
            >
              {t("downloadPdf")}
            </a>
          </article>
          <ExportForm
            companyId={companyId}
            format="dphdp3"
            period={period}
            preparedOn={new Intl.DateTimeFormat("sv-SE", {
              timeZone: "Europe/Prague",
            }).format(new Date())}
            personType={report.result.company.personType}
            defaults={filingDefaults}
            epoAddress={epoAddress.ok ? epoAddress.value : null}
            finalized={Boolean(periodLock)}
          />
        </div>
      </section>
    </PageLayout>
  );
}
