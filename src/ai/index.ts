import { AiProviderError, type AiProvider } from "@/application/ai-provider";
import type { AppClient, SystemClient } from "@/application/client";
import { listAvailableAiProviders } from "@/application/platform-ai";
import { platformAnthropicAiProvider } from "./anthropic";
import { fakeAiProvider } from "./fake";
import { platformOpenAiProvider } from "./openai";

export type AiProviderChoice = Pick<AiProvider, "name" | "region">;

/** Providers a Company can currently consent to. Fake remains local-only. */
export async function availableCompanyAiProviders(client: AppClient): Promise<AiProviderChoice[]> {
  if (process.env.AI_PROVIDER === "fake") {
    const fake = fakeAiProvider();
    return [{ name: fake.name, region: fake.region }];
  }
  return (await listAvailableAiProviders(client)).map(({ provider, region }) => ({ name: provider, region }));
}

/** Adapters available to the worker; real providers resolve configuration per Organization. */
export function configuredAiProviders(system: SystemClient): AiProvider[] {
  if (process.env.AI_PROVIDER === "fake") return [fakeAiProvider()];
  if (["platform", "anthropic", "openai"].includes(process.env.AI_PROVIDER ?? "")) {
    return [platformAnthropicAiProvider(system), platformOpenAiProvider(system)];
  }
  throw new Error(`Unknown AI_PROVIDER ${JSON.stringify(process.env.AI_PROVIDER)}. See .env.example.`);
}

/**
 * The AI provider named by `AI_PROVIDER`. Without a SystemClient this returns
 * metadata for consent/UI; the worker supplies one to resolve encrypted keys.
 */
export function configuredAiProvider(system?: SystemClient): AiProvider {
  if (process.env.AI_PROVIDER === "fake") return fakeAiProvider();
  if (process.env.AI_PROVIDER === "anthropic") {
    if (system) return platformAnthropicAiProvider(system);
    const unavailable = async (): Promise<never> => {
      throw new AiProviderError("worker_configuration_required", "The worker resolves Anthropic configuration", {
        transient: false,
      });
    };
    return { name: "anthropic", region: "global", split: unavailable, extract: unavailable };
  }
  if (process.env.AI_PROVIDER === "openai") {
    if (system) return platformOpenAiProvider(system);
    const unavailable = async (): Promise<never> => {
      throw new AiProviderError("worker_configuration_required", "The worker resolves OpenAI configuration", {
        transient: false,
      });
    };
    return { name: "openai", region: "global", split: unavailable, extract: unavailable };
  }
  throw new Error(`Unknown AI_PROVIDER ${JSON.stringify(process.env.AI_PROVIDER)}. See .env.example.`);
}
