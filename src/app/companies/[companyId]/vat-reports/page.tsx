import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, getCompanySetupChecklist, getMyCompanyRole } from "@/application/companies";
import { documentQueueQuery, parseDocumentQueue } from "@/application/document-queue";
import {
  getReportingPeriodReadiness,
  listReportingPeriods,
  readinessDocumentCounts,
  type ReadinessDocumentFilter,
} from "@/application/reporting-period-readiness";
import {
  getPeriodLock,
  getVatReport,
  listVatReportTransitions,
} from "@/application/vat-reports";
import { isReportingPeriod } from "@/application/vat-rules";
import { requireUserClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/empty-state";
import { DataTable } from "@/components/data-table";
import { formatDateTime } from "@/lib/format-date";
import { PageLayout } from "@/components/app-shell";
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
  const [report, periodLock, role, readinessResult, setup, transitions, t] = await Promise.all([
    getVatReport(client, companyId, period),
    getPeriodLock(client, companyId, period),
    getMyCompanyRole(client, companyId),
    getReportingPeriodReadiness(client, { companyId, period }),
    getCompanySetupChecklist(client, companyId),
    listVatReportTransitions(client, companyId, period),
    getTranslations(),
  ]);
  if (!readinessResult.ok) notFound();
  const readiness = readinessResult.value;
  const readinessCounts = readinessDocumentCounts(readiness);
  const readinessHref = (filter: ReadinessDocumentFilter) => `/companies/${companyId}/documents?${documentQueueQuery(parseDocumentQueue({
    view: "all",
    readiness: filter,
    reportingPeriod: period,
  }))}`;
  const identityComplete = setup.some((item) =>
    item.step === "identity" && item.state === "completed"
  );
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
    <PageLayout className="company-workspace vat-reports" measure="wide">
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
            {readiness.ready ? <strong className="vat-readiness-count">{t("vatReports.ready")}</strong> : <Link
              className="vat-readiness-count"
              href={readinessHref("blockers")}
            >{t("vatReports.blockerCount", { count: readinessCounts.blockers })}</Link>}
          </header>
          <dl className="vat-document-groups">
            {groupRows.map(([group, ids]) => (
              <div key={group}>
                <dt>{t(`vatReports.groups.${group}`)}</dt>
                <dd>{group === "rejected" ? <Link
                  aria-label={t("vatReports.openRejectedDocuments", { count: ids.length })}
                  href={readinessHref("rejected")}
                >{ids.length}</Link> : ids.length}</dd>
              </div>
            ))}
          </dl>
          {readinessCounts.warnings > 0 && (
            <p className="vat-readiness-warning">
              <Link href={readinessHref("warnings")}>{t("vatReports.warningCount", {
                count: readinessCounts.warnings,
              })}</Link>
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
                  date: formatDateTime(readiness.snapshot.generatedAt),
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
                  summary={{
                    blockerCount: report?.finalization.blockerCount ?? readinessCounts.blockers,
                    warningCount: report?.finalization.warningCount ?? readinessCounts.warnings,
                    rejectedDocumentCount: report?.finalization.rejectedDocumentCount ?? readinessCounts.rejected,
                    snapshotCurrent: readiness.snapshot?.freshness === "current",
                    identityComplete,
                  }}
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
      <section className="vat-transition-history">
        <h2>{t("vatReports.transitionHistory")}</h2>
        <p>{t("vatReports.transitionHistoryHint")}</p>
        {transitions.length > 0 ? (
          <DataTable
            caption={t("vatReports.transitionHistory")}
            rows={transitions}
            columns={[
              {
                key: "occurredAt",
                header: t("vatReports.transitionTime"),
                render: (transition) => (
                  <time dateTime={transition.occurredAt}>
                    {formatDateTime(transition.occurredAt)}
                  </time>
                ),
              },
              {
                key: "action",
                header: t("vatReports.transitionAction"),
                render: (transition) => t(
                  transition.action === "vat_report.finalized"
                    ? "vatReports.transitionFinalized"
                    : "vatReports.transitionUnlocked",
                ),
              },
              {
                key: "actorEmail",
                header: t("vatReports.transitionActor"),
                render: (transition) => transition.actorEmail ?? transition.actorUserId,
              },
              {
                key: "unlockReason",
                header: t("vatReports.unlockReason"),
                render: (transition) => transition.unlockReason ?? t("vatReports.notAvailable"),
              },
            ]}
          />
        ) : (
          <EmptyState title={t("vatReports.noTransitions")} />
        )}
      </section>
    </PageLayout>
  );
}
