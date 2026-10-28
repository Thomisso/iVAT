import type { AppClient, Result } from "./client";

export type OrganizationAiUsage = {
  companyId: string;
  companyName: string;
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
};

export type PlatformAiUsage = {
  organizationId: string;
  organizationName: string;
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
};

type UsageQueryError = "forbidden" | "invalid_period";

function expectedError(error: { code?: string; hint?: string | null }): UsageQueryError | null {
  if (error.code === "42501") return "forbidden";
  if (error.hint === "invalid_period") return "invalid_period";
  return null;
}

export async function listOrganizationAiUsage(
  client: AppClient,
  input: { organizationId: string; from: string; to: string; companyId?: string },
): Promise<Result<OrganizationAiUsage[], UsageQueryError>> {
  const { data, error } = await client.rpc("list_organization_ai_usage", {
    target_organization_id: input.organizationId,
    period_from: input.from,
    period_to: input.to,
    target_company_id: input.companyId,
  });
  if (error) {
    const refusal = expectedError(error);
    if (refusal) return { ok: false, error: refusal };
    throw error;
  }
  return {
    ok: true,
    value: data.map((row) => ({
      companyId: row.company_id,
      companyName: row.company_name,
      provider: row.provider,
      model: row.model,
      requests: Number(row.requests),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
    })),
  };
}

export async function listPlatformAiUsage(
  client: AppClient,
  input: { from: string; to: string },
): Promise<Result<PlatformAiUsage[], UsageQueryError>> {
  const { data, error } = await client.rpc("list_platform_ai_usage", {
    period_from: input.from,
    period_to: input.to,
  });
  if (error) {
    const refusal = expectedError(error);
    if (refusal) return { ok: false, error: refusal };
    throw error;
  }
  return {
    ok: true,
    value: data.map((row) => ({
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      provider: row.provider,
      model: row.model,
      requests: Number(row.requests),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
    })),
  };
}
