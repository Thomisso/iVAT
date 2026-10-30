import { isUuid, type AppClient, type Result } from "./client";
import { extractJob, splitJob, type JobQueue } from "./processing";

export type AiConfigurationSummary = {
  id: string;
  label: string;
  provider: string;
  credentialLastFour: string;
  isDefault: boolean;
  assignedCompanyIds: string[];
};

/** A model an AI Configuration names, with its price in USD per one million tokens, or null when unpriced. */
export type AiModelPrice = {
  model: string;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
};

export async function listAiConfigurationProviders(
  client: AppClient,
): Promise<Result<string[], "forbidden">> {
  const { data, error } = await client.rpc("list_ai_configuration_providers");
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: data };
}

export type CreateAiConfigurationInput = {
  label: string;
  provider: string;
  splitModel: string;
  extractModel: string;
  credential: string;
};

export type UpdateAiConfigurationInput = Omit<CreateAiConfigurationInput, "credential"> & {
  id: string;
  /** Omit to retain the encrypted credential when the provider is unchanged. */
  credential?: string;
};

type AiConfigurationError =
  | "forbidden"
  | "label_required"
  | "label_taken"
  | "model_required"
  | "invalid_credential"
  | "credential_required"
  | "unknown_provider";

function validateInput(input: Omit<CreateAiConfigurationInput, "credential"> & { credential?: string }):
  Exclude<AiConfigurationError, "forbidden" | "label_taken" | "credential_required" | "unknown_provider"> | null {
  if (!input.label.trim()) return "label_required";
  if (!input.splitModel.trim() || !input.extractModel.trim()) return "model_required";
  if (input.credential !== undefined && input.credential.length < 4) return "invalid_credential";
  return null;
}

function expectedError(error: { code?: string; hint?: string | null }): AiConfigurationError | null {
  if (error.code === "42501") return "forbidden";
  if (error.code === "23505") return "label_taken";
  if (
    error.hint === "label_required"
    || error.hint === "model_required"
    || error.hint === "invalid_credential"
    || error.hint === "credential_required"
    || error.hint === "unknown_provider"
  ) return error.hint;
  return null;
}

export async function createAiConfiguration(
  client: AppClient,
  input: CreateAiConfigurationInput,
): Promise<Result<{ id: string }, AiConfigurationError>> {
  const invalid = validateInput(input);
  if (invalid) return { ok: false, error: invalid };
  const { data, error } = await client.rpc("create_ai_configuration", {
    configuration_label: input.label,
    target_provider: input.provider,
    target_split_model: input.splitModel,
    target_extract_model: input.extractModel,
    provider_credential: input.credential,
  });
  if (error) {
    const refusal = expectedError(error);
    if (refusal) return { ok: false, error: refusal };
    throw error;
  }
  return { ok: true, value: { id: data } };
}

export async function updateAiConfiguration(
  client: AppClient,
  input: UpdateAiConfigurationInput,
  jobs?: JobQueue,
): Promise<Result<null, AiConfigurationError>> {
  if (!isUuid(input.id)) return { ok: false, error: "forbidden" };
  const invalid = validateInput(input);
  if (invalid) return { ok: false, error: invalid };
  const { error } = await client.rpc("update_ai_configuration", {
    target_configuration_id: input.id,
    configuration_label: input.label,
    target_provider: input.provider,
    target_split_model: input.splitModel,
    target_extract_model: input.extractModel,
    ...(input.credential === undefined ? {} : { provider_credential: input.credential }),
  });
  if (error) {
    const refusal = expectedError(error);
    if (refusal) return { ok: false, error: refusal };
    throw error;
  }
  if (jobs) {
    const resumed = await resumePlatformAiProcessing(client, jobs, { configurationId: input.id });
    if (!resumed.ok) return resumed;
  }
  return { ok: true, value: null };
}

/** Secret-free, model-free DTOs safe to cross the Server Component boundary. */
export async function listAiConfigurations(
  client: AppClient,
): Promise<Result<AiConfigurationSummary[], "forbidden">> {
  const { data, error } = await client.rpc("list_ai_configurations");
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: data as unknown as AiConfigurationSummary[] };
}

export type AiConfigurationModelPrices = { configurationId: string; models: AiModelPrice[] };

/** The models of every AI Configuration with their prices. SuperAdmin with MFA only. */
export async function listAiModelPrices(
  client: AppClient,
): Promise<Result<AiConfigurationModelPrices[], "forbidden">> {
  const { data, error } = await client.rpc("list_ai_model_prices");
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: data as unknown as AiConfigurationModelPrices[] };
}

type AiModelPriceError = "forbidden" | "invalid_price" | "unknown_model";

function validPrice(price: number | null) {
  return price === null || (Number.isFinite(price) && price >= 0);
}

/**
 * Sets the prices of the named models of an AI Configuration. A model whose
 * input and output prices are both null loses its price; recorded usage keeps its cost.
 */
export async function setAiModelPrices(
  client: AppClient,
  input: { configurationId: string; prices: AiModelPrice[] },
): Promise<Result<null, AiModelPriceError>> {
  if (!isUuid(input.configurationId)) return { ok: false, error: "forbidden" };
  const complete = input.prices.every((price) =>
    validPrice(price.inputPricePerMillion)
    && validPrice(price.outputPricePerMillion)
    && (price.inputPricePerMillion === null) === (price.outputPricePerMillion === null));
  if (!complete) return { ok: false, error: "invalid_price" };
  const { error } = await client.rpc("set_ai_model_prices", {
    target_configuration_id: input.configurationId,
    prices: input.prices,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.hint === "invalid_price" || error.hint === "unknown_model") return { ok: false, error: error.hint };
    throw error;
  }
  return { ok: true, value: null };
}

export async function assignCompanyAiConfiguration(
  client: AppClient,
  input: { companyId: string; configurationId: string },
  jobs?: JobQueue,
): Promise<Result<null, "forbidden">> {
  if (!isUuid(input.companyId) || !isUuid(input.configurationId)) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("assign_company_ai_configuration", {
    target_company_id: input.companyId,
    target_configuration_id: input.configurationId,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  if (jobs) {
    const resumed = await resumePlatformAiProcessing(client, jobs, { companyId: input.companyId });
    if (!resumed.ok) return resumed;
  }
  return { ok: true, value: null };
}

export async function resumePlatformAiProcessing(
  client: AppClient,
  jobs: JobQueue,
  target: { companyId?: string; configurationId?: string },
): Promise<Result<null, "forbidden">> {
  if (
    (!target.companyId && !target.configurationId)
    || (target.companyId !== undefined && !isUuid(target.companyId))
    || (target.configurationId !== undefined && !isUuid(target.configurationId))
  ) return { ok: false, error: "forbidden" };
  const { data, error } = await client.rpc("resume_platform_ai_processing", {
    target_company_id: target.companyId,
    target_configuration_id: target.configurationId,
  });
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error) throw error;
  for (let index = 0; index < data.length; index += 1) {
    const work = data[index];
    try {
      await jobs.send(work.target_kind === "source_file" ? splitJob(work.target_id) : extractJob(work.target_id));
    } catch (queueError) {
      const restored = await client.rpc("restore_platform_ai_processing_wait", {
        target_work: data.slice(index),
      });
      if (restored.error) throw restored.error;
      throw queueError;
    }
  }
  return { ok: true, value: null };
}

export async function setDefaultAiConfiguration(
  client: AppClient,
  configurationId: string,
): Promise<Result<null, "forbidden">> {
  if (!isUuid(configurationId)) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("set_default_ai_configuration", {
    target_configuration_id: configurationId,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: null };
}

export async function clearDefaultAiConfiguration(
  client: AppClient,
): Promise<Result<null, "forbidden">> {
  const { error } = await client.rpc("clear_default_ai_configuration");
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: null };
}
