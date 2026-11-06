import { companyPageContext, safeCompanyReturnTo } from "@/application/return-context";
import { CompanyReturnLink } from "@/components/company-return-link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany } from "@/application/companies";
import { controlStatementPreviewData } from "@/application/control-statement-preview";
import { getCompanyFilingDefaults, resolveEpoAddress } from "@/application/company-filing-defaults";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { getPeriodLock, getVatReport } from "@/application/vat-reports";
import { requireUserClient } from "@/lib/supabase/server";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { PageLayout } from "@/components/app-shell";
import { formatDate, formatDateTime } from "@/lib/format-date";
import { ExportContextProvider } from "../../export-context";
import { PdfDownload } from "../../pdf-download";
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
  params, searchParams,
}: PageProps<"/companies/[companyId]/vat-reports/[period]/control-statement">) {
  const { companyId, period } = await params;
  const search = await searchParams;
  const returnTo = safeCompanyReturnTo(companyId, search.returnTo);
  const context = companyPageContext(companyId, `/companies/${companyId}/vat-reports/${period}/control-statement`, search);
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
  const preparedOn = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());
  const preview = controlStatementPreviewData(report.result);
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
            <h1>{t("controlStatementTitle", { period })}</h1>
            <p>{t("controlStatementDescription")}</p>
          </div>
          {periodLock && <StatusBadge status="locked" />}
        </div>
      </header>
      <PeriodNavigation
        returnTo={returnTo}
        active="controlStatement"
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
        <h2>{t("controlStatement")}</h2>
        <p>{t("controlStatementHint", { count: preview.sections.length })}</p>
        {preview.sections.length === 0 ? (
          <p>{t("noEntries")}</p>
        ) : (
          preview.sections.map((section) => (
            <section className="report-section" key={section.section}>
              <h3>{t("section", { section: section.section })}</h3>
              <DataTable
                caption={t("section", { section: section.section })}
                rows={section.entries.flatMap(entry => (entry.rateBreakdown.length ? entry.rateBreakdown : [null]).map((rate, rateIndex) => ({
                  id: `${entry.entryIndex}-${rateIndex}`, entry, rate, rateIndex,
                })))}
                rowId={row => `control-entry-${row.entry.entryIndex}${row.rateIndex ? `-rate-${row.rateIndex}` : ""}`}
                columns={[
                  {
                    key: "document",
                    header: t("controlStatementPdf.document"),
                    render: row => row.rateIndex === 0 && <div className="control-statement-entry">
                      <span>{row.entry.documentNumber ?? t("aggregateEntry")}</span>
                      {row.entry.counterpartyVatId && <small>{row.entry.counterpartyVatId}</small>}
                      {row.entry.counterpartyCountry && <small>{row.entry.counterpartyCountry}</small>}
                      {row.entry.taxPointDate && <small>{formatDate(row.entry.taxPointDate)}</small>}
                      {row.entry.reverseChargeCode && <small>{t("reverseChargeCode")} {row.entry.reverseChargeCode}</small>}
                    </div>,
                  },
                  { key: "rate", header: t("rateLabel"), render: row => row.rate && t("rate", { rate: row.rate.rate }) },
                  {
                    key: "netAmount", header: t("netAmount"), align: "right",
                    render: row => row.rate && <ReportAmount amount={row.rate.netAmount} companyId={companyId}
                      returnTo={`${context}#control-entry-${row.entry.entryIndex}`} documentIds={row.rate.documentIds} documents={report.documents} />,
                  },
                  {
                    key: "vatAmount", header: t("vatAmount"), align: "right",
                    render: row => row.rate && <ReportAmount amount={row.rate.vatAmount} companyId={companyId}
                      returnTo={`${context}#control-entry-${row.entry.entryIndex}`} documentIds={row.rate.documentIds} documents={report.documents} />,
                  },
                ]}
              />
              <h4>{t("controlStatementPdf.sectionTotals")}</h4>
              <dl className="report-totals" aria-label={`${t("section", { section: section.section })} · ${t("controlStatementPdf.sectionTotals")}`}>
                <div><dt>{t("netAmount")}</dt><dd><ReportAmount amount={section.totals.netAmount} companyId={companyId}
                  returnTo={`${context}#control-entry-${section.entries[0].entryIndex}`} documentIds={section.documentIds} documents={report.documents} /></dd></div>
                <div><dt>{t("vatAmount")}</dt><dd><ReportAmount amount={section.totals.vatAmount} companyId={companyId}
                  returnTo={`${context}#control-entry-${section.entries[0].entryIndex}`} documentIds={section.documentIds} documents={report.documents} /></dd></div>
              </dl>
            </section>
          ))
        )}
      </section>
      <ReportIssues companyId={companyId} readiness={readiness} report={report} returnTo={`${context}#vat-output-issues`} />
      <section className="vat-output-actions">
        <h2>{t("controlStatementActions")}</h2>
        <ExportContextProvider preparedOn={preparedOn}>
        <div className="vat-output-action-grid">
          <article className="vat-export-card">
            <span className="vat-section-label">{t("pdfFormat")}</span>
            <h3>{t("controlStatementPdfPreview")}</h3>
            <p>{t("pdfPreviewHint")}</p>
            <PdfDownload
              href={`/companies/${companyId}/vat-reports/${period}/control-statement/pdf`}
              thumbnailHref={`/companies/${companyId}/vat-reports/${period}/control-statement/thumbnail`}
              fileName={`DPHKH1-${period}.pdf`}
            >
              {t("downloadControlStatementPdf")}
            </PdfDownload>
          </article>
          <ExportForm
            companyId={companyId}
            format="dphkh1"
            period={period}
            preparedOn={preparedOn}
            personType={report.result.company.personType}
            defaults={filingDefaults}
            epoAddress={epoAddress.ok ? epoAddress.value : null}
            finalized={Boolean(periodLock)}
          />
        </div>
        </ExportContextProvider>
      </section>
    </PageLayout>
  );
}
