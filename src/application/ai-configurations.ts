import { isUuid, type AppClient, type Result } from "./client";

export type AiConfigurationSummary = {
  id: string;
  label: string;
  provider: string;
  credentialLastFour: string;
  isDefault: boolean;
  assignedCompanyIds: string[];
};

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

export async function assignCompanyAiConfiguration(
  client: AppClient,
  input: { companyId: string; configurationId: string },
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
