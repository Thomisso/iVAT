import type { AppClient, Result } from "./client";

export type OrganizationAiProviderKey = {
  provider: string;
  hasOrganizationKey: boolean;
  organizationKeyLastFour: string | null;
};

type OrganizationAiKeyError =
  | "forbidden"
  | "unknown_provider"
  | "invalid_organization_key"
  | "dpa_acknowledgement_required";

function expectedError(error: {
  code?: string;
  hint?: string | null;
}): OrganizationAiKeyError | null {
  if (error.code === "42501") return "forbidden";
  if (
    error.hint === "unknown_provider" ||
    error.hint === "invalid_organization_key" ||
    error.hint === "dpa_acknowledgement_required"
  ) {
    return error.hint;
  }
  return null;
}

export async function saveOrganizationAiProviderKey(
  client: AppClient,
  input: {
    organizationId: string;
    provider: string;
    apiKey: string;
    dpaAcknowledged: boolean;
  },
): Promise<Result<null, OrganizationAiKeyError>> {
  if (!input.dpaAcknowledged) return { ok: false, error: "dpa_acknowledgement_required" };
  if (input.apiKey.length < 4) return { ok: false, error: "invalid_organization_key" };
  const { error } = await client.rpc("save_organization_ai_provider_key", {
    target_organization_id: input.organizationId,
    target_provider: input.provider,
    organization_key: input.apiKey,
    dpa_acknowledged: input.dpaAcknowledged,
  });
  if (error) {
    const refusal = expectedError(error);
    if (refusal) return { ok: false, error: refusal };
    throw error;
  }
  return { ok: true, value: null };
}

export async function listOrganizationAiProviderKeys(
  client: AppClient,
  organizationId: string,
): Promise<Result<OrganizationAiProviderKey[], "forbidden">> {
  const { data, error } = await client.rpc("list_organization_ai_provider_keys", {
    target_organization_id: organizationId,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return {
    ok: true,
    value: data.map((settings) => ({
      provider: settings.provider,
      hasOrganizationKey: settings.has_organization_key,
      organizationKeyLastFour: settings.organization_key_last_four,
    })),
  };
}

export async function removeOrganizationAiProviderKey(
  client: AppClient,
  input: { organizationId: string; provider: string },
): Promise<Result<null, "forbidden">> {
  const { error } = await client.rpc("remove_organization_ai_provider_key", {
    target_organization_id: input.organizationId,
    target_provider: input.provider,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: null };
}
