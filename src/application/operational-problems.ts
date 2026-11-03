import { listAiConfigurations, type AiConfigurationSummary } from "./ai-configurations";
import {
  listPlatformAiProcessingAllowances,
  type PlatformAiProcessingAllowance,
} from "./ai-processing-allowance";
import {
  listPlatformAiProcessingIssues,
  type PlatformAiProcessingIssue,
} from "./ai-processing-interventions";
import type { AiProcessingIssueClassification } from "./ai-provider";
import type { AppClient, Result } from "./client";

export type OperationalProblemKind =
  | "allowance_exhausted"
  | "allowance_high"
  | "waiting_documents"
  | AiProcessingIssueClassification
  | "terminal_processing_job"
  | "failed_company_export";

export type OperationalProblemCompany = {
  id: string;
  name: string;
  affectedDocumentCount: number;
};

export type OperationalProblem = {
  id: string;
  kind: OperationalProblemKind;
  severity: "critical" | "warning";
  firstDetectedAt: string;
  ageMinutes: number;
  targetIds: string[];
  affectedDocumentCount: number;
  configuration: null | {
    id: string;
    label: string;
    provider: string;
    credentialLastFour: string;
  };
  companies: OperationalProblemCompany[];
  detailHref: string;
};

type OperationalCompanyContext = {
  companyId: string;
  companyName: string;
  aiProcessingEnabled: boolean;
  uploadedDocumentCount: number;
  oldestUploadedAt: string | null;
  oldestWaitingAt: string | null;
};

type OperationalFailedJobContext = {
  name: string;
  companyId: string;
  companyName: string;
  affectedCount: number;
  firstFailedAt: string;
  targetIds: string[];
};

type OperationalContext = {
  companies: OperationalCompanyContext[];
  failedJobs: OperationalFailedJobContext[];
};

type ProblemAccumulator = Omit<OperationalProblem, "affectedDocumentCount" | "ageMinutes" | "companies"> & {
  companies: Map<string, OperationalProblemCompany>;
};

const earlier = (left: string, right: string) => left < right ? left : right;

function configurationFor(
  configurationId: string | null,
  configurations: Map<string, AiConfigurationSummary>,
): OperationalProblem["configuration"] {
  if (!configurationId) return null;
  const configuration = configurations.get(configurationId);
  return configuration ? {
    id: configuration.id,
    label: configuration.label,
    provider: configuration.provider,
    credentialLastFour: configuration.credentialLastFour,
  } : null;
}

function addProblem(
  groups: Map<string, ProblemAccumulator>,
  input: {
    kind: OperationalProblemKind;
    severity: OperationalProblem["severity"];
    firstDetectedAt: string;
    configurationId: string | null;
    companyId: string;
    companyName: string;
    affectedDocumentCount: number;
    discriminator?: string;
    targetIds?: string[];
  },
  configurations: Map<string, AiConfigurationSummary>,
) {
  const scope = input.configurationId ?? input.companyId;
  const key = [input.kind, scope, input.discriminator].filter(Boolean).join(":");
  const existing = groups.get(key);
  if (existing) {
    existing.firstDetectedAt = earlier(existing.firstDetectedAt, input.firstDetectedAt);
    existing.targetIds = [...new Set([...existing.targetIds, ...(input.targetIds ?? [])])];
    const company = existing.companies.get(input.companyId);
    if (company) company.affectedDocumentCount += input.affectedDocumentCount;
    else existing.companies.set(input.companyId, {
      id: input.companyId,
      name: input.companyName,
      affectedDocumentCount: input.affectedDocumentCount,
    });
    return;
  }
  const configuration = configurationFor(input.configurationId, configurations);
  groups.set(key, {
    id: key,
    kind: input.kind,
    severity: input.severity,
    firstDetectedAt: input.firstDetectedAt,
    targetIds: input.targetIds ?? [],
    configuration,
    companies: new Map([[input.companyId, {
      id: input.companyId,
      name: input.companyName,
      affectedDocumentCount: input.affectedDocumentCount,
    }]]),
    detailHref: (input.kind === "terminal_processing_job" || input.kind === "failed_company_export")
      ? "/platform/administration#failed-jobs"
      : configuration
        ? `/platform/ai-settings#configuration-${configuration.id}`
        : `/platform/ai-settings#company-${input.companyId}`,
  });
}

/** Groups live platform state by root cause and shared AI Configuration. */
export function groupOperationalProblems(input: {
  allowances: PlatformAiProcessingAllowance[];
  configurations: AiConfigurationSummary[];
  context: OperationalContext;
  issues: PlatformAiProcessingIssue[];
  now: string;
}): OperationalProblem[] {
  const groups = new Map<string, ProblemAccumulator>();
  const configurations = new Map(input.configurations.map((configuration) => [configuration.id, configuration]));
  const allowanceByCompany = new Map(input.allowances.map((allowance) => [allowance.companyId, allowance]));
  const companyContext = new Map(input.context.companies.map((company) => [company.companyId, company]));

  for (const allowance of input.allowances) {
    if (allowance.allowance === null) continue;
    const exhausted = allowance.allowance === 0 || allowance.used >= allowance.allowance;
    const high = !exhausted && allowance.allowance > 0 && allowance.used / allowance.allowance >= 0.8;
    if (!exhausted && !high) continue;
    const context = companyContext.get(allowance.companyId);
    addProblem(groups, {
      kind: exhausted ? "allowance_exhausted" : "allowance_high",
      severity: exhausted ? "critical" : "warning",
      firstDetectedAt: context?.oldestWaitingAt ?? input.now,
      configurationId: allowance.configurationId,
      companyId: allowance.companyId,
      companyName: allowance.companyName,
      affectedDocumentCount: allowance.waitingDocuments,
    }, configurations);
  }

  for (const company of input.context.companies) {
    if (company.uploadedDocumentCount === 0) continue;
    const allowance = allowanceByCompany.get(company.companyId);
    addProblem(groups, {
      kind: "waiting_documents",
      severity: company.aiProcessingEnabled ? "warning" : "critical",
      firstDetectedAt: company.oldestUploadedAt ?? input.now,
      configurationId: allowance?.configurationId ?? null,
      companyId: company.companyId,
      companyName: company.companyName,
      affectedDocumentCount: company.uploadedDocumentCount,
    }, configurations);
  }

  for (const issue of input.issues) {
    addProblem(groups, {
      kind: issue.classification,
      severity: issue.state === "terminal" || issue.classification !== "provider_unavailable"
        ? "critical"
        : "warning",
      firstDetectedAt: issue.firstDetectedAt,
      configurationId: issue.configurationId,
      companyId: issue.companyId,
      companyName: issue.companyName,
      affectedDocumentCount: 1,
    }, configurations);
  }

  for (const job of input.context.failedJobs) {
    const allowance = allowanceByCompany.get(job.companyId);
    const exportFailure = job.name === "complete-company-export";
    addProblem(groups, {
      kind: exportFailure ? "failed_company_export" : "terminal_processing_job",
      severity: "critical",
      firstDetectedAt: job.firstFailedAt,
      configurationId: exportFailure ? null : allowance?.configurationId ?? null,
      companyId: job.companyId,
      companyName: job.companyName,
      affectedDocumentCount: job.affectedCount,
      discriminator: job.name,
      targetIds: job.targetIds,
    }, configurations);
  }

  return [...groups.values()].map((problem) => {
    const companies = [...problem.companies.values()].sort((left, right) => left.name.localeCompare(right.name));
    return {
      ...problem,
      companies,
      ageMinutes: Math.max(0, Math.floor(
        (Date.parse(input.now) - Date.parse(problem.firstDetectedAt)) / 60_000,
      )),
      affectedDocumentCount: companies.reduce((sum, company) => sum + company.affectedDocumentCount, 0),
    };
  }).sort((left, right) =>
    (left.severity === right.severity ? 0 : left.severity === "critical" ? -1 : 1)
    || left.firstDetectedAt.localeCompare(right.firstDetectedAt)
    || left.id.localeCompare(right.id)
  );
}

export async function listPlatformOperationalProblems(
  client: AppClient,
): Promise<Result<OperationalProblem[], "forbidden">> {
  const [allowances, issues, configurations, contextResult] = await Promise.all([
    listPlatformAiProcessingAllowances(client),
    listPlatformAiProcessingIssues(client),
    listAiConfigurations(client),
    client.rpc("list_platform_operational_context"),
  ]);
  if (!allowances.ok || !issues.ok || !configurations.ok || contextResult.error?.code === "42501") {
    return { ok: false, error: "forbidden" };
  }
  if (contextResult.error) throw contextResult.error;
  return {
    ok: true,
    value: groupOperationalProblems({
      allowances: allowances.value,
      configurations: configurations.value,
      context: contextResult.data as unknown as OperationalContext,
      issues: issues.value,
      now: new Date().toISOString(),
    }),
  };
}
