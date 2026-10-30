import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import { getCompanyFilingDefaults, resolveEpoAddress } from "@/application/company-filing-defaults";
import { documentQueueQuery, parseDocumentQueue } from "@/application/document-queue";
import {
  listReportingPeriods,
  readinessDocumentCounts,
  type ReadinessDocumentFilter,
} from "@/application/reporting-period-readiness";
import {
  getVatProcessingWizard,
  VAT_PROCESSING_STEPS,
  type VatProcessingStep,
  type VatProcessingStepState,
} from "@/application/vat-processing";
import { getVatReport, listVatReportTransitions } from "@/application/vat-reports";
import { isReportingPeriod } from "@/application/vat-rules";
import { requireUserClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/empty-state";
import { DataTable } from "@/components/data-table";
import { StatusBadge, type DocumentStatus } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format-date";
import { PageLayout } from "@/components/app-shell";
import { GenerateForm } from "./generate-form";
import { PeriodLockForm } from "./period-lock-form";
import { PeriodNavigation, PeriodSelector } from "./period-navigation";
import { ExportForm } from "./export-form";

const stateBadge: Record<VatProcessingStepState, DocumentStatus> = {
  done: "approved",
  needs_attention: "needs-review",
  blocked: "locked",
  not_started: "uploaded",
};

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
  const selectedPeriod = periods.some((candidate) => candidate.period === requestedPeriod)
    ? requestedPeriod!
    : periods.find((candidate) => candidate.oldestUnfinished)?.period ??
      periods.at(-1)?.period;
  if (!selectedPeriod) notFound();
  const period: string = selectedPeriod;
  const [report, role, wizardResult, transitions, filingDefaults, t] = await Promise.all([
    getVatReport(client, companyId, period),
    getMyCompanyRole(client, companyId),
    getVatProcessingWizard(client, { companyId, period }),
    listVatReportTransitions(client, companyId, period),
    getCompanyFilingDefaults(client, companyId),
    getTranslations(),
  ]);
  if (!wizardResult.ok) notFound();
  const { readiness, steps, documentsToReview, documentsToReviewCount, locked } = wizardResult.value;
  const epoAddress = report ? resolveEpoAddress(report.result.company, filingDefaults) : null;
  const readinessCounts = readinessDocumentCounts(readiness);
  const readinessHref = (filter: ReadinessDocumentFilter) => `/companies/${companyId}/documents?${documentQueueQuery(parseDocumentQueue({
    view: "all",
    readiness: filter,
    reportingPeriod: period,
  }))}`;
  const periodHref = (segment: string) => `/companies/${companyId}/vat-reports/${period}/${segment}`;
  const stepNumber = (key: VatProcessingStep["key"]) => VAT_PROCESSING_STEPS.indexOf(key) + 1;
  const stepTitle = (key: VatProcessingStep["key"]) => t(`vatReports.wizard.steps.${key}.title`);
  const groupRows = (
    [
      ["processing", readiness.groups.processing],
      ["failed", readiness.groups.failed],
      ["needsReview", readiness.groups.needsReview],
      ["approved", readiness.groups.approved],
      ["rejected", readiness.groups.rejected],
    ] as const
  ).filter(([, ids]) => ids.length > 0);

  function stepBody(step: VatProcessingStep) {
    switch (step.key) {
      case "review":
        return <>
          {groupRows.length > 0 && <dl className="vat-document-groups">
            {groupRows.map(([group, ids]) => (
              <div key={group}>
                <dt>{t(`vatReports.groups.${group}`)}</dt>
                <dd>{group === "rejected" ? <Link
                  aria-label={t("vatReports.openRejectedDocuments", { count: ids.length })}
                  href={readinessHref("rejected")}
                >{ids.length}</Link> : ids.length}</dd>
              </div>
            ))}
          </dl>}
          {documentsToReviewCount === 0
            ? <p>{t("vatReports.wizard.noDocumentsToReview")}</p>
            : <>
              <h3>{t("vatReports.wizard.documentsToReview")}</h3>
              <ul className="vat-wizard-documents">
                {documentsToReview.map((document) => {
                  const reasons = [...new Set(readiness.blockers
                    .filter((finding) => finding.documentId === document.id)
                    .map((finding) => finding.code))];
                  return <li key={document.id}>
                    <Link href={`/companies/${companyId}/documents/${document.id}`}>
                      {document.documentNumber ?? t("vatReports.documentFallback")}
                    </Link>
                    {document.counterparty?.name && <span>{document.counterparty.name}</span>}
                    <small>{reasons.map((code) => t(`vatReports.blockerReasons.${code}`)).join(" · ")}</small>
                  </li>;
                })}
              </ul>
              <Link href={readinessHref("blockers")}>
                {t("vatReports.blockerCount", { count: readinessCounts.blockers })}
              </Link>
            </>}
          {readinessCounts.warnings > 0 && (
            <p className="vat-readiness-warning">
              <Link href={readinessHref("warnings")}>{t("vatReports.warningCount", {
                count: readinessCounts.warnings,
              })}</Link>
            </p>
          )}
        </>;
      case "generate":
        return <>
          {readiness.snapshot ? <>
            <dl className="vat-wizard-facts">
              <div>
                <dt>{t("vatReports.savedSnapshot")}</dt>
                <dd>{t("vatReports.snapshotGenerated", {
                  date: formatDateTime(readiness.snapshot.generatedAt),
                })}</dd>
              </div>
              <div>
                <dt>{t("vatReports.freshness")}</dt>
                <dd data-freshness={readiness.snapshot.freshness}>
                  {t(`vatReports.freshnessState.${readiness.snapshot.freshness}`)}
                </dd>
              </div>
              <div>
                <dt>{t("vatReports.snapshotDocuments")}</dt>
                <dd>{report?.documents.length ?? 0}</dd>
              </div>
            </dl>
            <p>{t(`vatReports.snapshotFreshness.${readiness.snapshot.freshness}`)}</p>
          </> : <p><strong>{t("vatReports.noSnapshot")}</strong> {t("vatReports.noSnapshotHint")}</p>}
          <div className="vat-wizard-actions">
            <GenerateForm
              key={period}
              companyId={companyId}
              period={period}
              exists={!!report}
              disabled={locked || step.state === "blocked"}
            />
            <a
              className="iv-btn iv-btn-secondary iv-btn-md"
              href={periodHref("xlsx")}
              download
            >
              {t("vatReports.excelOverview")}
            </a>
          </div>
        </>;
      case "outputs":
        return step.state === "blocked" ? null : <div className="vat-wizard-actions">
          <Link className="iv-btn iv-btn-secondary iv-btn-md" href={periodHref("vat-return")}>
            {t("vatReports.openVatReturn")}
          </Link>
          <Link className="iv-btn iv-btn-secondary iv-btn-md" href={periodHref("control-statement")}>
            {t("vatReports.openControlStatement")}
          </Link>
        </div>;
      case "export":
        return step.state === "blocked" || !report ? null : <>
          <div className="vat-output-action-grid">
            {(["dphdp3", "dphkh1"] as const).map((format) => <ExportForm
              key={`${period}:${format}`}
              companyId={companyId}
              format={format}
              period={period}
              preparedOn={new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date())}
              personType={report.result.company.personType}
              defaults={filingDefaults}
              epoAddress={epoAddress?.ok ? epoAddress.value : null}
              finalized={false}
              presentation="wizard"
              disabled={locked}
              canEditFilingDefaults={role === "administrator"}
            />)}
          </div>
          <Link href={periodHref("exports")}>{t("vatReports.wizard.openExportHistory")}</Link>
        </>;
      case "finalize":
        return <>
          {locked && <p><strong>{t("statusBadge.locked")}</strong></p>}
          {role === "administrator" && (locked || step.state !== "blocked") && (
            <PeriodLockForm
              key={`${period}:${locked ? "locked" : "unlocked"}`}
              companyId={companyId}
              period={period}
              locked={locked}
              summary={{
                blockerCount: report?.finalization.blockerCount ?? readinessCounts.blockers,
                warningCount: report?.finalization.warningCount ?? readinessCounts.warnings,
                rejectedDocumentCount: report?.finalization.rejectedDocumentCount ?? readinessCounts.rejected,
                snapshotCurrent: readiness.snapshot?.freshness === "current",
                identityComplete: step.reason !== "identity_incomplete",
              }}
            />
          )}
        </>;
    }
  }

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
      </header>
      <PeriodSelector companyId={companyId} period={period} periods={periods} />
      <PeriodNavigation
        active="processing"
        companyId={companyId}
        period={period}
        reportAvailable={!!report}
      />
      <ol aria-label={t("vatReports.wizard.title")} className="vat-wizard">
        {steps.map((step) => (
          <li
            aria-labelledby={`vat-step-${step.key}`}
            className="vat-wizard-step"
            data-state={step.state}
            key={step.key}
          >
            <header>
              <span aria-hidden="true" className="vat-wizard-number">{stepNumber(step.key)}</span>
              <div>
                <h2 id={`vat-step-${step.key}`}>{stepTitle(step.key)}</h2>
                <p>{t(`vatReports.wizard.steps.${step.key}.hint`)}</p>
              </div>
              <StatusBadge status={stateBadge[step.state]}>
                {t(`vatReports.wizard.state.${step.state}`)}
              </StatusBadge>
            </header>
            {(step.reason || step.blockedBy) && <p className="vat-wizard-reason" role="note">
              {step.blockedBy && t("vatReports.wizard.blockedBy", {
                number: stepNumber(step.blockedBy),
                title: stepTitle(step.blockedBy),
              })}
              {step.blockedBy && step.reason && " "}
              {step.reason && t(`vatReports.wizard.reasons.${step.reason}`)}
            </p>}
            <div className="vat-wizard-body">{stepBody(step)}</div>
          </li>
        ))}
      </ol>
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
