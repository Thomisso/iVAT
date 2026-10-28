import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import {
  getReportingPeriodReadiness,
  listReportingPeriods,
} from "@/application/reporting-period-readiness";
import { getPeriodLock, getVatReport } from "@/application/vat-reports";
import { isReportingPeriod } from "@/application/vat-rules";
import { requireUserClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/empty-state";
import { formatDocumentDate } from "@/lib/format-date";
import { GenerateForm } from "./generate-form";
import { PeriodLockForm } from "./period-lock-form";
import { PeriodNavigation, PeriodSelector } from "./period-navigation";

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
    : periods.find((candidate) => candidate.oldestUnfinished)?.period ??
      periods.at(-1)?.period;
  if (!period) notFound();
  const [report, periodLock, role, readinessResult, t] = await Promise.all([
    getVatReport(client, companyId, period),
    getPeriodLock(client, companyId, period),
    getMyCompanyRole(client, companyId),
    getReportingPeriodReadiness(client, { companyId, period }),
    getTranslations(),
  ]);
  if (!readinessResult.ok) notFound();
  const readiness = readinessResult.value;
  const groupRows = (
    [
      ["processing", readiness.groups.processing],
      ["failed", readiness.groups.failed],
      ["needsReview", readiness.groups.needsReview],
      ["approved", readiness.groups.approved],
      ["rejected", readiness.groups.rejected],
    ] as const
  ).filter(([, ids]) => ids.length > 0);
  return (
    <main className="company-workspace vat-reports">
      <header className="company-page-header vat-report-header">
        <p>
          <Link href={`/companies/${companyId}/vat`}>
            {t("vatReports.backToPeriods")}
          </Link>
        </p>
        <span className="vat-output-context">
          {company.name} · {period}
        </span>
        <h1>{t("vatReports.processingTitle", { period })}</h1>
        <p>{t("vatReports.processingDescription")}</p>
      </header>
      <PeriodSelector companyId={companyId} period={period} periods={periods} />
      <PeriodNavigation
        active="processing"
        companyId={companyId}
        period={period}
        reportAvailable={!!report}
      />
      <div className="vat-processing-grid">
        <section
          className={`vat-readiness ${readiness.ready ? "is-ready" : "has-blockers"}`}
        >
          <header>
            <div>
              <span className="vat-section-label">
                {t("vatReports.liveData")}
              </span>
              <h2>
                {t(
                  readiness.ready
                    ? "vatReports.readinessReady"
                    : "vatReports.readinessBlocked",
                )}
              </h2>
              <p>
                {t(
                  readiness.ready
                    ? "vatReports.readinessReadyHint"
                    : "vatReports.readinessBlockedHint",
                )}
              </p>
            </div>
            <strong>
              {readiness.ready
                ? t("vatReports.ready")
                : t("vatReports.blockerCount", {
                    count: readiness.blockers.length,
                  })}
            </strong>
          </header>
          <dl className="vat-document-groups">
            {groupRows.map(([group, ids]) => (
              <div key={group}>
                <dt>{t(`vatReports.groups.${group}`)}</dt>
                <dd>{ids.length}</dd>
              </div>
            ))}
          </dl>
          {readiness.warnings.length > 0 && (
            <p className="vat-readiness-warning">
              {t("vatReports.warningCount", {
                count: readiness.warnings.length,
              })}
            </p>
          )}
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
          <span className="vat-section-label">
            {t("vatReports.savedSnapshot")}
          </span>
          {readiness.snapshot ? (
            <>
              <h2>
                {t("vatReports.snapshotGenerated", {
                  date: formatDocumentDate(
                    readiness.snapshot.generatedAt,
                    true,
                  ),
                })}
              </h2>
              <p>
                {t(
                  `vatReports.snapshotFreshness.${readiness.snapshot.freshness}`,
                )}
              </p>
              <dl>
                <div>
                  <dt>{t("vatReports.freshness")}</dt>
                  <dd data-freshness={readiness.snapshot.freshness}>
                    {t(
                      `vatReports.freshnessState.${readiness.snapshot.freshness}`,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t("vatReports.snapshotDocuments")}</dt>
                  <dd>{report?.documents.length ?? 0}</dd>
                </div>
              </dl>
              {periodLock && (
                <p>
                  <strong>{t("statusBadge.locked")}</strong>
                </p>
              )}
              {role === "administrator" && (
                <PeriodLockForm
                  key={`${period}:${periodLock ? "locked" : "unlocked"}`}
                  companyId={companyId}
                  period={period}
                  locked={!!periodLock}
                />
              )}
            </>
          ) : (
            <>
              <h2>{t("vatReports.noSnapshot")}</h2>
              <p>{t("vatReports.noSnapshotHint")}</p>
            </>
          )}
        </aside>
      </div>
      {!report && (
        <EmptyState icon="report" title={t("vatReports.none")} />
      )}
      {report && (
        <section className="vat-snapshot-destinations">
          <h2>{t("vatReports.snapshotOutputs")}</h2>
          <p>{t("vatReports.snapshotOutputsHint")}</p>
          <div>
            <Link
              className="iv-btn iv-btn-secondary iv-btn-md"
              href={`/companies/${companyId}/vat-reports/${period}/vat-return`}
            >
              {t("vatReports.openVatReturn")}
            </Link>
            <Link
              className="iv-btn iv-btn-secondary iv-btn-md"
              href={`/companies/${companyId}/vat-reports/${period}/control-statement`}
            >
              {t("vatReports.openControlStatement")}
            </Link>
          </div>
        </section>
      )}
    </main>
  );
}
