import type { AppClient, Result, SystemClient } from "./client";

export type PlatformAiProviderSettings = {
  provider: string;
  available: boolean;
  splitModel: string;
  extractModel: string;
  hasPlatformKey: boolean;
  platformKeyLastFour: string | null;
};

export type AvailableAiProvider = { provider: string; region: string };

/** Provider metadata safe to show while a Company Administrator chooses consent. */
export async function listAvailableAiProviders(client: AppClient): Promise<AvailableAiProvider[]> {
  const { data, error } = await client.rpc("list_available_ai_providers");
  if (error) throw error;
  return data.map((provider) => ({ provider: provider.provider, region: provider.region }));
}

export type ConfigurePlatformAiProviderInput = {
  provider: string;
  available: boolean;
  splitModel: string;
  extractModel: string;
  /** Omit to keep the existing encrypted key. */
  apiKey?: string;
};

/** UI hint only; database functions remain the authority for every platform action. */
export async function isSuperAdmin(client: AppClient): Promise<boolean> {
  const { data, error } = await client.rpc("current_user_can_administrate_platform");
  if (error) return false;
  return data;
}

type PlatformAiSettingsError = "forbidden" | "unknown_provider" | "model_required" | "invalid_platform_key";

function expectedError(error: { code?: string; hint?: string | null }): PlatformAiSettingsError | null {
  if (error.code === "42501") return "forbidden";
  if (
    error.hint === "unknown_provider" ||
    error.hint === "model_required" ||
    error.hint === "invalid_platform_key"
  ) {
    return error.hint;
  }
  return null;
}

export async function configurePlatformAiProvider(
  client: AppClient,
  input: ConfigurePlatformAiProviderInput,
): Promise<Result<null, PlatformAiSettingsError>> {
  if (!input.splitModel.trim() || !input.extractModel.trim()) return { ok: false, error: "model_required" };
  if (input.apiKey !== undefined && input.apiKey.length < 4) return { ok: false, error: "invalid_platform_key" };
  const { error } = await client.rpc("configure_platform_ai_provider", {
    target_provider: input.provider,
    provider_available: input.available,
    target_split_model: input.splitModel,
    target_extract_model: input.extractModel,
    ...(input.apiKey === undefined ? {} : { platform_key: input.apiKey }),
  });
  if (error) {
    const refusal = expectedError(error);
    if (refusal) return { ok: false, error: refusal };
    throw error;
  }
  return { ok: true, value: null };
}

export async function listPlatformAiProviders(
  client: AppClient,
): Promise<Result<PlatformAiProviderSettings[], "forbidden">> {
  const { data, error } = await client.rpc("list_platform_ai_providers");
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return {
    ok: true,
    value: data.map((settings) => ({
      provider: settings.provider,
      available: settings.available,
      splitModel: settings.split_model,
      extractModel: settings.extract_model,
      hasPlatformKey: settings.has_platform_key,
      platformKeyLastFour: settings.platform_key_last_four,
    })),
  };
}

export type PlatformOrganization = { id: string; name: string; platformKeyEnabled: boolean };

export async function listPlatformOrganizations(
  client: AppClient,
  provider: string,
): Promise<Result<PlatformOrganization[], "forbidden">> {
  const { data, error } = await client.rpc("list_platform_organizations", { target_provider: provider });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return {
    ok: true,
    value: data.map((organization) => ({
      id: organization.id,
      name: organization.name,
      platformKeyEnabled: organization.platform_key_enabled,
    })),
  };
}

export async function setOrganizationPlatformAiAccess(
  client: AppClient,
  input: { organizationId: string; provider: string; enabled: boolean },
): Promise<Result<null, "forbidden">> {
  const { error } = await client.rpc("set_organization_platform_ai_access", {
    target_organization_id: input.organizationId,
    target_provider: input.provider,
    access_enabled: input.enabled,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: null };
}

export type ResolvedPlatformAiProvider = { apiKey: string; splitModel: string; extractModel: string };
export type PlatformAiConfigurationError =
  | "provider_unavailable"
  | "platform_key_not_configured"
  | "platform_key_not_enabled";

export async function resolvePlatformAiProvider(
  system: SystemClient,
  organizationId: string,
  provider: string,
): Promise<Result<ResolvedPlatformAiProvider, PlatformAiConfigurationError>> {
  const { data, error } = await system.rpc("resolve_platform_ai_provider", {
    target_organization_id: organizationId,
    target_provider: provider,
  });
  if (error) {
    if (
      error.hint === "provider_unavailable" ||
      error.hint === "platform_key_not_configured" ||
      error.hint === "platform_key_not_enabled"
    ) {
      return { ok: false, error: error.hint };
    }
    throw error;
  }
  const settings = data[0];
  if (!settings) return { ok: false, error: "platform_key_not_configured" };
  return {
    ok: true,
    value: {
      apiKey: settings.api_key,
      splitModel: settings.split_model,
      extractModel: settings.extract_model,
    },
  };
}
