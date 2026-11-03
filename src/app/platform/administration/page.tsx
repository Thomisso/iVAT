import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  retryFailedProcessingJobAction,
  setPlatformOrganizationBlockedAction,
} from "@/app/actions";
import {
  getPlatformUploadLimits,
  listPlatformOrganizationCompanies,
} from "@/application/platform-administration";
import { listAiConfigurationProviders, listAiConfigurations } from "@/application/ai-configurations";
import { listPlatformAiProcessingAllowances } from "@/application/ai-processing-allowance";
import { listFailedProcessingJobs } from "@/application/processing-administration";
import {
  type OperationalProblemKind,
} from "@/application/operational-problems";
import { CommandButton } from "@/components/command-button";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { requireUserClient } from "@/lib/supabase/server";
import { UploadLimitsForm } from "./upload-limits-form";
import { OperationalProblemRemediation } from "./operational-problem-remediation";
import { currentPlatformOperationalProblems } from "../current-operational-problems";
import { PlatformPageLayout } from "../platform-page-layout";

export default async function PlatformAdministrationPage() {
  const client = await requireUserClient();
  const organizations = await listPlatformOrganizationCompanies(client);
  if (!organizations.ok) notFound();
  const [limits, jobs, problems, providers, configurations, allowances, t] = await Promise.all([
    getPlatformUploadLimits(client),
    listFailedProcessingJobs(client),
    currentPlatformOperationalProblems(),
    listAiConfigurationProviders(client),
    listAiConfigurations(client),
    listPlatformAiProcessingAllowances(client),
    getTranslations("platformAdministration"),
  ]);
  if (
    !limits.ok || !jobs.ok || !problems.ok || !providers.ok
    || !configurations.ok || !allowances.ok
  ) notFound();

  const problemLabels: Record<OperationalProblemKind, string> = {
    allowance_exhausted: t("problemAllowanceExhausted"),
    allowance_high: t("problemAllowanceHigh"),
    waiting_documents: t("problemWaitingDocuments"),
    configuration_missing: t("problemConfigurationMissing"),
    configuration_unusable: t("problemConfigurationUnusable"),
    invalid_credentials: t("problemInvalidCredentials"),
    provider_credits_exhausted: t("problemProviderCreditsExhausted"),
    provider_unavailable: t("problemProviderUnavailable"),
    provider_response_invalid: t("problemProviderResponseInvalid"),
    processing_failed: t("problemProcessingFailed"),
    terminal_processing_job: t("problemTerminalJob"),
  };

  return (
    <>
      <PlatformPageLayout title={t("title")} description={t("intro")}>

        <section className="panel operational-problems" aria-labelledby="operational-problems-title">
          <header className="operational-problems-header">
            <div>
              <h2 id="operational-problems-title">{t("operationalProblems")}</h2>
              <p className="iv-muted">{t("operationalProblemsIntro")}</p>
            </div>
            <span className="operational-problems-count">{problems.value.length}</span>
          </header>
          {problems.value.length === 0 ? (
            <p className="operational-problems-healthy">{t("noOperationalProblems")}</p>
          ) : (
            <ol className="operational-problems-list">
              {problems.value.map((problem) => {
                const age = problem.ageMinutes >= 1_440
                  ? t("ageDays", { count: Math.floor(problem.ageMinutes / 1_440) })
                  : problem.ageMinutes >= 60
                    ? t("ageHours", { count: Math.floor(problem.ageMinutes / 60) })
                    : t("ageMinutes", { count: problem.ageMinutes });
                return (
                  <li key={problem.id} className={`operational-problem operational-problem-${problem.severity}`}>
                    <div className="operational-problem-summary">
                      <div>
                        <h3>{problemLabels[problem.kind]}</h3>
                        <p className="iv-muted">{t("problemAge", { age })}</p>
                      </div>
                      <StatusBadge status={problem.severity === "critical" ? "failed" : "waiting-for-platform"}>
                        {problem.severity === "critical" ? t("critical") : t("warning")}
                      </StatusBadge>
                    </div>
                    <dl className="operational-problem-facts">
                      <div>
                        <dt>{t("affectedDocuments")}</dt>
                        <dd>{problem.affectedDocumentCount}</dd>
                      </div>
                      {problem.configuration && (
                        <div>
                          <dt>{t("configuration")}</dt>
                          <dd>
                            {problem.configuration.label} · {problem.configuration.provider} · {t("credentialSuffix", {
                              lastFour: problem.configuration.credentialLastFour,
                            })}
                          </dd>
                        </div>
                      )}
                    </dl>
                    <div className="operational-problem-companies">
                      <strong>{t("affectedCompanies")}</strong>
                      <ul>
                        {problem.companies.map((company) => (
                          <li key={company.id}>
                            <span>{company.name}</span>
                            <span>{t("companyDocumentCount", { count: company.affectedDocumentCount })}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <Link className="operational-problem-link" href={problem.detailHref}>
                      {t("viewProblemDetail")}
                    </Link>
                    <OperationalProblemRemediation
                      allowances={allowances.value}
                      configurations={configurations.value}
                      failedJobs={jobs.value}
                      problem={problem}
                      providers={providers.value}
                    />
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="panel">
          <h2>{t("organizations")}</h2>
          <DataTable
            caption={t("organizations")}
            rows={organizations.value}
            columns={[
              {
                key: "name", header: t("organization"),
                render: (organization) => <Link href={`/organizations/${organization.id}/users`}>{organization.name}</Link>,
              },
              {
                key: "companies", header: t("companies"),
                render: (organization) => <ul>{organization.companies.map((company) => <li key={company.id}>
                  <Link href={company.deletedAt || organization.blocked
                    ? `/platform/companies/${company.id}/history` : `/companies/${company.id}`}>
                    {t("companyIdentity", { name: company.name, ico: company.ico })}{company.deletedAt ? ` · ${t("retainedHistory")}` : ""}
                  </Link>
                </li>)}</ul>,
              },
              {
                key: "blocked",
                header: t("status"),
                render: (organization) => organization.blocked
                  ? <StatusBadge status="failed">{t("blocked")}</StatusBadge>
                  : <StatusBadge status="approved">{t("active")}</StatusBadge>,
              },
              {
                key: "action",
                header: t("action"),
                render: (organization) => (
                  <CommandButton
                    action={setPlatformOrganizationBlockedAction}
                    fields={{ organizationId: organization.id, blocked: String(!organization.blocked) }}
                    variant={organization.blocked ? "secondary" : "danger"}
                    size="sm"
                  >
                    {organization.blocked ? t("unblock") : t("block")}
                  </CommandButton>
                ),
              },
            ]}
          />
        </section>

        <section className="panel" id="failed-jobs">
          <h2>{t("failedJobs")}</h2>
          <p className="iv-muted">{t("failedJobsIntro")}</p>
          {jobs.value.length === 0 ? <p>{t("noFailedJobs")}</p> : (
            <DataTable
              caption={t("failedJobs")}
              rows={jobs.value}
              columns={[
                { key: "name", header: t("job") },
                { key: "targetId", header: t("target"), mono: true },
                { key: "failedAt", header: t("failedAt") },
                { key: "error", header: t("failure") },
                {
                  key: "action",
                  header: t("action"),
                  render: (job) => (
                    <CommandButton
                      action={retryFailedProcessingJobAction}
                      fields={{ jobId: job.id }}
                      size="sm"
                    >
                      {t("retry")}
                    </CommandButton>
                  ),
                },
              ]}
            />
          )}
        </section>

        <section className="panel">
          <h2>{t("uploadLimits")}</h2>
          <p className="iv-muted">{t("uploadLimitsIntro")}</p>
          <UploadLimitsForm limits={limits.value} />
        </section>
      </PlatformPageLayout>
    </>
  );
}
