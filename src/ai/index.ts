import { AiProviderError, type AiProvider } from "@/application/ai-provider";
import type { SystemClient } from "@/application/client";
import { platformAnthropicAiProvider } from "./anthropic";
import { fakeAiProvider } from "./fake";

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
  throw new Error(`Unknown AI_PROVIDER ${JSON.stringify(process.env.AI_PROVIDER)}. See .env.example.`);
}
