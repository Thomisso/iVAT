"use client";

import Link from "next/link";
import { closeFailedExportAttemptAction, retryFailedProcessingJobAction, takeOverFailedProcessingJobAction } from "@/app/actions";
import type { AiConfigurationSummary } from "@/application/ai-configurations";
import type { PlatformAiProcessingAllowance } from "@/application/ai-processing-allowance";
import type { OperationalProblem, OperationalProblemKind } from "@/application/operational-problems";
import type { FailedProcessingJob } from "@/application/processing-administration";
import { CommandButton } from "@/components/command-button";
import { useTranslations } from "next-intl";
import { AiConfigurationAssignmentForm } from "../ai-settings/ai-configuration-assignment-form";
import { AiConfigurationForm } from "../ai-settings/ai-configuration-form";
import { AiProcessingAllowanceForm } from "../ai-settings/ai-processing-allowance-form";

const CONFIGURATION_INCIDENTS = new Set<OperationalProblemKind>([
  "configuration_missing",
  "configuration_unusable",
  "invalid_credentials",
  "provider_credits_exhausted",
  "provider_unavailable",
  "provider_response_invalid",
  "processing_failed",
]);

export function OperationalProblemRemediation({
  allowances,
  configurations,
  failedJobs,
  problem,
  providers,
}: {
  allowances: PlatformAiProcessingAllowance[];
  configurations: AiConfigurationSummary[];
  failedJobs: FailedProcessingJob[];
  problem: OperationalProblem;
  providers: string[];
}) {
  const t = useTranslations("platformAdministration");
  const allowanceByCompany = new Map(allowances.map((allowance) => [allowance.companyId, allowance]));

  if (problem.kind === "allowance_exhausted" || problem.kind === "allowance_high") {
    return (
      <div className="operational-remediation">
        <h4>{t("resolveAllowance")}</h4>
        {problem.companies.map((company) => (
          <div className="operational-remediation-company" key={company.id}>
            <strong>{company.name}</strong>
            <AiProcessingAllowanceForm
              companyId={company.id}
              allowance={allowanceByCompany.get(company.id)?.allowance ?? 50}
            />
          </div>
        ))}
      </div>
    );
  }

  if (CONFIGURATION_INCIDENTS.has(problem.kind) || (
    problem.kind === "waiting_documents" && !problem.configuration
  )) {
    const current = problem.configuration
      ? configurations.find((configuration) => configuration.id === problem.configuration?.id)
      : undefined;
    return (
      <div className="operational-remediation">
        <h4>{t("resolveConfiguration")}</h4>
        {current && (
          <details>
            <summary>{t("repairConfiguration", { label: current.label })}</summary>
            <AiConfigurationForm configuration={current} providers={providers} />
          </details>
        )}
        {configurations.length > 0 ? problem.companies.map((company) => (
          <div className="operational-remediation-company" key={company.id}>
            <strong>{company.name}</strong>
            <AiConfigurationAssignmentForm companyId={company.id} configurations={configurations} />
          </div>
        )) : (
          <details>
            <summary>{t("createConfiguration")}</summary>
            <AiConfigurationForm providers={providers} />
          </details>
        )}
      </div>
    );
  }

  if (problem.kind === "terminal_processing_job" || problem.kind === "failed_company_export") {
    const retryable = failedJobs.filter((job) => problem.targetIds.includes(job.targetId));
    return (
      <div className="operational-remediation">
        <h4>{t("retryTerminalJobs")}</h4>
        {retryable.length > 0 ? retryable.map((job) => (
          <div className="operational-remediation-job" key={job.id}>
            <span>{job.name} · <code>{job.targetId}</code></span>
            <CommandButton
              action={retryFailedProcessingJobAction}
              fields={{ jobId: job.id }}
              size="sm"
            >
              {t("retry")}
            </CommandButton>
            {job.name === "complete-company-export" ? (
              <CommandButton action={closeFailedExportAttemptAction} fields={{ jobId: job.id, retryCount: String(job.retryCount) }} size="sm">
                {t("closeExportAttempt")}
              </CommandButton>
            ) : (
              <CommandButton action={takeOverFailedProcessingJobAction} fields={{ jobId: job.id }} size="sm">
                {t("manualTakeover")}
              </CommandButton>
            )}
          </div>
        )) : (
          <Link href="#failed-jobs">{t("viewFailedJobs")}</Link>
        )}
      </div>
    );
  }

  return null;
}
