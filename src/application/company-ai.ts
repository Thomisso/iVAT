import {
  AI_CREDENTIAL_SOURCES,
  type AiCredentialSource,
  type AiProvider,
} from "./ai-provider";
import { isUuid, type AppClient, type Result } from "./client";
import { extractJob, splitJob, type JobQueue } from "./processing";

export { AI_CREDENTIAL_SOURCES } from "./ai-provider";
export type { AiCredentialSource } from "./ai-provider";
export type CompanyAiOption = {
  provider: string;
  region: string;
  credentialSource: AiCredentialSource;
};
export type AiProcessingConsent = CompanyAiOption | null;
export type CompanyAiConfigurationError = "forbidden" | "provider_unavailable" | "consent_required";

export function companyAiOptionValue(option: CompanyAiOption): string {
  return [option.credentialSource, option.provider, option.region].map(encodeURIComponent).join(":");
}

function isAiCredentialSource(value: string): value is AiCredentialSource {
  return AI_CREDENTIAL_SOURCES.some((candidate) => candidate === value);
}

export function parseCompanyAiOptionValue(value: string): CompanyAiOption | null {
  const parts = value.split(":");
  if (parts.length !== 3) return null;
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    return null;
  }
  const [credentialSource, provider, region] = decoded;
  if (!isAiCredentialSource(credentialSource) || !provider || !region) return null;
  return { credentialSource, provider, region };
}

/** Usable, secret-free choices for one Company. Local fake AI is never a production option. */
export async function listCompanyAiOptions(client: AppClient, companyId: string): Promise<CompanyAiOption[]> {
  if (!isUuid(companyId)) return [];
  const { data, error } = await client.rpc("list_company_ai_options", { target_company_id: companyId });
  if (error) {
    if (error.code === "42501") return [];
    throw error;
  }
  const options = data.map((option) => ({
    provider: option.provider,
    region: option.region,
    credentialSource: option.credential_source,
  }));
  return process.env.AI_PROVIDER === "fake"
    ? [{ provider: "fake", region: "local", credentialSource: "local" }, ...options]
    : options;
}

function expectedConfigurationError(error: { code?: string; hint?: string | null }): CompanyAiConfigurationError | null {
  if (error.code === "42501") return "forbidden";
  if (error.hint === "provider_unavailable") return "provider_unavailable";
  return null;
}

async function waitingIds(
  client: AppClient,
  table: "source_file" | "document",
  companyId: string,
): Promise<string[]> {
  const pageSize = 1_000;
  const ids: string[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client
      .from(table)
      .select("id")
      .eq("company_id", companyId)
      .in("status", ["uploaded", "processing"])
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    ids.push(...data.map(({ id }) => id));
    if (data.length < pageSize) break;
  }
  return ids;
}

/**
 * Records explicit consent and resumes every Split/Extraction that was waiting
 * for configuration. Database validation makes the selected option authoritative.
 */
export async function configureCompanyAiProcessing(
  client: AppClient,
  jobs: JobQueue,
  input: { companyId: string; option: CompanyAiOption; consent: boolean },
): Promise<Result<null, CompanyAiConfigurationError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  if (!input.consent) return { ok: false, error: "consent_required" };
  const { error } = await client.rpc("configure_company_ai_processing", {
    target_company_id: input.companyId,
    target_provider: input.option.provider,
    target_region: input.option.region,
    target_credential_source: input.option.credentialSource,
  });
  if (error) {
    const expected = expectedConfigurationError(error);
    if (expected) return { ok: false, error: expected };
    throw error;
  }

  const [sourceFileIds, documentIds] = await Promise.all([
    waitingIds(client, "source_file", input.companyId),
    waitingIds(client, "document", input.companyId),
  ]);
  for (const id of sourceFileIds) await jobs.send(splitJob(id));
  for (const id of documentIds) await jobs.send(extractJob(id));
  return { ok: true, value: null };
}

/** Backward-compatible command for non-UI callers; production choices are still database-validated. */
export async function enableAiProcessing(
  client: AppClient,
  jobs: JobQueue,
  input: {
    companyId: string;
    provider: Pick<AiProvider, "name" | "region">;
    credentialSource?: AiCredentialSource;
  },
): Promise<Result<null, CompanyAiConfigurationError>> {
  if (input.provider.name === "fake" && input.provider.region === "local") {
    return configureCompanyAiProcessing(client, jobs, {
      companyId: input.companyId,
      option: { provider: "fake", region: "local", credentialSource: "local" },
      consent: true,
    });
  }
  const options = await listCompanyAiOptions(client, input.companyId);
  const option = input.credentialSource
    ? { provider: input.provider.name, region: input.provider.region, credentialSource: input.credentialSource }
    : options.find((candidate) =>
      candidate.provider === input.provider.name
      && candidate.region === input.provider.region
      && candidate.credentialSource === "organization"
    ) ?? options.find((candidate) =>
      candidate.provider === input.provider.name && candidate.region === input.provider.region
    );
  if (!option) return { ok: false, error: "provider_unavailable" };
  return configureCompanyAiProcessing(client, jobs, { companyId: input.companyId, option, consent: true });
}

/** Withdraws consent; originals and waiting processing state remain intact. */
export async function disableAiProcessing(
  client: AppClient,
  companyId: string,
): Promise<Result<null, "forbidden">> {
  if (!isUuid(companyId)) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("disable_company_ai_processing", { target_company_id: companyId });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: null };
}
