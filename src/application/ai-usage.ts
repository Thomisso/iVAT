import { isUuid, type AppClient, type Result } from "./client";

export const AI_USAGE_GROUPINGS = [
  "organization",
  "company",
  "ai_configuration",
  "model",
  "operation",
  "month",
] as const;
export type AiUsageGrouping = (typeof AI_USAGE_GROUPINGS)[number];

export const AI_USAGE_OPERATIONS = ["split", "extract"] as const;
export type AiUsageOperation = (typeof AI_USAGE_OPERATIONS)[number];

export type PlatformAiUsageQuery = {
  /** First calendar day (yyyy-mm-dd), inclusive. */
  from: string;
  /** Last calendar day (yyyy-mm-dd), inclusive. */
  to: string;
  groupBy: AiUsageGrouping;
  organizationId?: string;
  companyId?: string;
  configurationId?: string;
  model?: string;
  operation?: AiUsageOperation;
};

/** Usage summed over one value of the chosen grouping. */
export type PlatformAiUsageGroup = {
  /** The grouped value: an id, model, operation or yyyy-mm; null for usage without an AI Configuration. */
  key: string | null;
  label: string | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** The sum of the known costs in USD, or null when no event of the group has a known cost. */
  costUsd: number | null;
  /** Events whose cost is unknown; they never count as zero. */
  unknownCostEvents: number;
};

type UsageQueryError = "forbidden" | "invalid_period";

function expectedError(error: { code?: string; hint?: string | null }): UsageQueryError | null {
  if (error.code === "42501") return "forbidden";
  if (error.hint === "invalid_period") return "invalid_period";
  return null;
}

export async function listPlatformAiUsage(
  client: AppClient,
  input: PlatformAiUsageQuery,
): Promise<Result<PlatformAiUsageGroup[], UsageQueryError>> {
  for (const id of [input.organizationId, input.companyId, input.configurationId]) {
    if (id !== undefined && !isUuid(id)) return { ok: true, value: [] };
  }
  const groups: PlatformAiUsageGroup[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.rpc("list_platform_ai_usage", {
      period_from: input.from,
      period_to: input.to,
      group_by: input.groupBy,
      target_organization_id: input.organizationId,
      target_company_id: input.companyId,
      target_configuration_id: input.configurationId,
      target_model: input.model,
      target_operation: input.operation,
    }).range(offset, offset + 999);
    if (error) {
      const refusal = expectedError(error);
      if (refusal) return { ok: false, error: refusal };
      throw error;
    }
    groups.push(...data.map((row) => ({
      key: row.group_key,
      label: row.group_label,
      requests: Number(row.requests),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
      unknownCostEvents: Number(row.unknown_cost_events),
    })));
    if (data.length < 1000) break;
  }
  return { ok: true, value: groups };
}

/** The models that have recorded platform AI usage, for filtering. */
export async function listPlatformAiUsageModels(client: AppClient): Promise<Result<string[], "forbidden">> {
  const models: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.rpc("list_platform_ai_usage_models").range(offset, offset + 999);
    if (error) {
      if (error.code === "42501") return { ok: false, error: "forbidden" };
      throw error;
    }
    models.push(...data);
    if (data.length < 1000) break;
  }
  return { ok: true, value: models };
}
