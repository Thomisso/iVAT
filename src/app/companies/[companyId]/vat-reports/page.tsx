import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import {
  getCompany,
  getMyCompanyRole,
} from "@/application/companies";
import {
  getReportingPeriodReadiness,
  listReportingPeriods,
} from "@/application/reporting-period-readiness";
import { getPeriodLock, getVatReport } from "@/application/vat-reports";
import { vatReturnPreviewData } from "@/application/vat-return-preview";
import { isReportingPeriod } from "@/application/vat-rules";
import { requireUserClient } from "@/lib/supabase/server";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Money } from "@/components/money";
import { StatusBadge } from "@/components/status-badge";
import { formatDocumentDate } from "@/lib/format-date";
import { GenerateForm } from "./generate-form";
import { ExportForm } from "./export-form";
import { PeriodLockForm } from "./period-lock-form";

export default async function VatReportsPage({
  params,
  searchParams,
}: PageProps<"/companies/[companyId]/vat-reports">) {
  const { companyId } = await params;
  const query = await searchParams;
  const requestedPeriod =
    typeof query.period === "string" && isReportingPeriod(query.period)
      ? query.period
      : null;
  const client = await requireUserClient();
  const [company, periods] = await Promise.all([
    getCompany(client, companyId),
    listReportingPeriods(client, companyId),
  ]);
  if (!company) notFound();
  const period = periods.some((candidate) => candidate.period === requestedPeriod)
    ? requestedPeriod!
    : periods.find((candidate) => candidate.oldestUnfinished)?.period ?? periods.at(-1)?.period;
  if (!period) notFound();
  const [report, periodLock, role, readinessResult, t, locale] = await Promise.all([
    getVatReport(client, companyId, period),
    getPeriodLock(client, companyId, period),
    getMyCompanyRole(client, companyId),
    getReportingPeriodReadiness(client, { companyId, period }),
    getTranslations(),
    getLocale(),
  ]);
  if (!readinessResult.ok) notFound();
  const readiness = readinessResult.value;
  const periodIndex = periods.findIndex((candidate) => candidate.period === period);
  const previousPeriod = periods[periodIndex - 1]?.period;
  const nextPeriod = periods[periodIndex + 1]?.period;
  const documents = report?.documents ?? [];
  const documentLink = (id: string) => (
    <Link href={`/companies/${companyId}/documents/${id}`}>
      {documents.find((d) => d.id === id)?.payload?.documentNumber ??
        t("documents.review")}
    </Link>
  );
  const drilldown = (amount: string, ids: string[]) =>
    ids.length ? (
      <details className="report-drilldown">
        <summary>
          <Money amount={Number(amount)} currency="CZK" locale={locale} />
        </summary>
        <ul aria-label={t("vatReports.contributors")}>
          {ids.map((id) => (
            <li key={id}>{documentLink(id)}</li>
          ))}
        </ul>
      </details>
    ) : (
      <Money amount={Number(amount)} currency="CZK" locale={locale} />
    );
  const result = report?.result;
  const preview = result ? vatReturnPreviewData(result) : null;
  const groupRows = ([
    ["processing", readiness.groups.processing],
    ["failed", readiness.groups.failed],
    ["needsReview", readiness.groups.needsReview],
    ["approved", readiness.groups.approved],
    ["rejected", readiness.groups.rejected],
  ] as const).filter(([, ids]) => ids.length > 0);
  return (
      <main className="company-workspace vat-reports">
        <header className="company-page-header vat-report-header">
          <p><Link href={`/companies/${companyId}/vat`}>{t("vatReports.backToPeriods")}</Link></p>
          <h1>{t("vatReports.processingTitle", { period })}</h1>
          <p>{t("vatReports.processingDescription")}</p>
        </header>
        <section className="vat-period-toolbar" aria-label={t("vatReports.selectPeriod")}>
          <Link aria-disabled={!previousPeriod} className={`vat-period-previous${!previousPeriod ? " is-disabled" : ""}`} href={previousPeriod ? `/companies/${companyId}/vat-reports?period=${previousPeriod}` : `?period=${period}`}>{t("vatReports.previous")}</Link>
          <form key={period}>
            <label htmlFor="reporting-period">{t("vatReports.period")}</label>
            <select defaultValue={period} id="reporting-period" name="period">
              {periods.map((candidate) => <option key={candidate.period} value={candidate.period}>{candidate.period}</option>)}
            </select>
            <button className="iv-btn iv-btn-secondary iv-btn-md" type="submit">{t("vatReports.show")}</button>
          </form>
          <Link aria-disabled={!nextPeriod} className={`vat-period-next${!nextPeriod ? " is-disabled" : ""}`} href={nextPeriod ? `/companies/${companyId}/vat-reports?period=${nextPeriod}` : `?period=${period}`}>{t("vatReports.next")}</Link>
        </section>
        <div className="vat-processing-grid">
          <section className={`vat-readiness ${readiness.ready ? "is-ready" : "has-blockers"}`}>
            <header>
              <div>
                <span className="vat-section-label">{t("vatReports.liveData")}</span>
                <h2>{t(readiness.ready ? "vatReports.readinessReady" : "vatReports.readinessBlocked")}</h2>
                <p>{t(readiness.ready ? "vatReports.readinessReadyHint" : "vatReports.readinessBlockedHint")}</p>
              </div>
              <strong>{readiness.ready ? t("vatReports.ready") : t("vatReports.blockerCount", { count: readiness.blockers.length })}</strong>
            </header>
            <dl className="vat-document-groups">
              {groupRows.map(([group, ids]) => <div key={group}>
                <dt>{t(`vatReports.groups.${group}`)}</dt>
                <dd>{ids.length}</dd>
              </div>)}
            </dl>
            {readiness.warnings.length > 0 && <p className="vat-readiness-warning">{t("vatReports.warningCount", { count: readiness.warnings.length })}</p>}
            <div className="vat-processing-actions">
              <GenerateForm
                key={period}
                companyId={companyId}
                period={period}
                exists={!!report}
                locked={!!periodLock}
              />
              <div>
                <strong>{t("vatReports.liveWorkbook")}</strong>
                <p>{t("vatReports.excelOverviewHint")}</p>
                <a
                  className="iv-btn iv-btn-secondary iv-btn-md"
                  href={`/companies/${companyId}/vat-reports/${period}/xlsx`}
                  download
                >
                  {t("vatReports.excelOverview")}
                </a>
              </div>
            </div>
          </section>
          <aside className="vat-snapshot-card">
            <span className="vat-section-label">{t("vatReports.savedSnapshot")}</span>
            {readiness.snapshot ? <>
              <h2>{t("vatReports.snapshotGenerated", { date: formatDocumentDate(readiness.snapshot.generatedAt, true) })}</h2>
              <p>{t(`vatReports.snapshotFreshness.${readiness.snapshot.freshness}`)}</p>
              <dl>
                <div><dt>{t("vatReports.freshness")}</dt><dd data-freshness={readiness.snapshot.freshness}>{t(`vatReports.freshnessState.${readiness.snapshot.freshness}`)}</dd></div>
                <div><dt>{t("vatReports.snapshotDocuments")}</dt><dd>{report?.documents.length ?? 0}</dd></div>
              </dl>
            </> : <><h2>{t("vatReports.noSnapshot")}</h2><p>{t("vatReports.noSnapshotHint")}</p></>}
          </aside>
        </div>
        {!report || !result || !preview ? (
          <EmptyState icon="report" title={t("vatReports.none")} />
        ) : (
          <>
            <section>
              <h2>{t("vatReports.draft", { period: preview.period })}</h2>
              {periodLock && <StatusBadge status="locked" />}
              <p>
                {preview.company.name} · {preview.company.vatId}
              </p>
              <p className="iv-muted">
                {preview.company.streetName} {preview.company.houseNumber}{preview.company.orientationNumber ? `/${preview.company.orientationNumber}` : ""}, {preview.company.postalCode}{" "}
                {preview.company.city}
              </p>
              <p className="iv-muted">
                {t("vatReports.generated", {
                  date: formatDocumentDate(report.generatedAt, true),
                })}
              </p>
              <p className="iv-muted">{t("vatReports.snapshot")}</p>
              {role === "administrator" && (
                <PeriodLockForm
                  key={`${period}:${periodLock ? "locked" : "unlocked"}`}
                  companyId={companyId}
                  period={period}
                  locked={!!periodLock}
                />
              )}
              <DataTable
                caption={t("vatReports.vatReturn")}
                rows={preview.lines.map((r) => ({ ...r, id: r.line }))}
                columns={[
                  {
                    key: "line",
                    header: t("vatReports.line"),
                    render: (r) => t(`vatReports.lines.${r.line}`),
                  },
                  {
                    key: "netAmount",
                    header: t("vatReports.netAmount"),
                    align: "right",
                    render: (r) => drilldown(r.netAmount, r.documentIds),
                  },
                  {
                    key: "vatAmount",
                    header: t("vatReports.vatAmount"),
                    align: "right",
                    render: (r) => drilldown(r.vatAmount, r.documentIds),
                  },
                ]}
              />
              <dl className="report-totals">
                {(
                  [
                    ["outputVat", result.totalDocumentIds.outputVat],
                    ["inputVat", result.totalDocumentIds.inputVat],
                    ["payable", result.totalDocumentIds.payable],
                    [
                      "excessDeduction",
                      result.totalDocumentIds.excessDeduction,
                    ],
                  ] as const
                ).map(([key, ids]) => (
                  <div key={key}>
                    <dt>{t(`vatReports.${key}`)}</dt>
                    <dd>{drilldown(preview.totals[key], [...ids])}</dd>
                  </div>
                ))}
              </dl>
              <a
                className="iv-btn iv-btn-secondary iv-btn-md"
                href={`/companies/${companyId}/vat-reports/${period}/pdf`}
                download={`DPHDP3-${period}.pdf`}
              >
                {t("vatReports.downloadPdf")}
              </a>
            </section>
            <section>
              <h2>{t("vatReports.controlStatement")}</h2>
              {result.controlStatement.length === 0 ? (
                <p>{t("vatReports.noEntries")}</p>
              ) : (
                result.controlStatement.map((entry, i) => (
                  <div className="report-section" key={`${entry.section}-${i}`}>
                    <h3>
                      {t("vatReports.section", { section: entry.section })}
                    </h3>
                    {entry.documentNumber && (
                      <p>
                        {entry.documentNumber} · {entry.counterpartyVatId} ·{" "}
                        {formatDocumentDate(entry.taxPointDate!)}
                        {entry.reverseChargeCode && (
                          <>
                            {" "}· {t("review.fields.reverseChargeCode")}{" "}
                            {entry.reverseChargeCode}
                          </>
                        )}
                      </p>
                    )}
                    <DataTable
                      caption={t("vatReports.section", {
                        section: entry.section,
                      })}
                      rows={entry.rateBreakdown.map((r) => ({
                        ...r,
                        id: String(r.rate),
                      }))}
                      columns={[
                        {
                          key: "rate",
                          header: t("review.fields.rate"),
                          render: (r) => t("vatReports.rate", { rate: r.rate }),
                        },
                        {
                          key: "netAmount",
                          header: t("vatReports.netAmount"),
                          align: "right",
                          render: (r) => drilldown(r.netAmount, r.documentIds),
                        },
                        {
                          key: "vatAmount",
                          header: t("vatReports.vatAmount"),
                          align: "right",
                          render: (r) => drilldown(r.vatAmount, r.documentIds),
                        },
                      ]}
                    />
                  </div>
                ))
              )}
            </section>
            <ExportForm
              key={report.id + report.generatedAt}
              companyId={companyId}
              period={period}
              preparedOn={new Intl.DateTimeFormat("sv-SE", {
                timeZone: "Europe/Prague",
              }).format(new Date())}
              personType={result.company.personType}
            />
            <section>
              <h2>{t("vatReports.excluded")}</h2>
              {result.excludedDocuments.length === 0 ? (
                <p>{t("vatReports.noExclusions")}</p>
              ) : (
                <ul>
                  {result.excludedDocuments.map((d) => (
                    <li key={d.documentId}>
                      {documentLink(d.documentId)} ·{" "}
                      {t(`vatReports.reasons.${d.reason}`)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
  );
}
