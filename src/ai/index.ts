import { AiProviderError, type AiProvider } from "@/application/ai-provider";
import { platformAnthropicAiProvider } from "./anthropic";
import { fakeAiProvider } from "./fake";
import { platformOpenAiProvider } from "./openai";

/** Adapters available to the worker; real providers resolve configuration per Organization. */
export function configuredAiProviders(): AiProvider[] {
  if (process.env.AI_PROVIDER === "fake") return [fakeAiProvider()];
  if (["platform", "anthropic", "openai"].includes(process.env.AI_PROVIDER ?? "")) {
    return [platformAnthropicAiProvider(), platformOpenAiProvider()];
  }
  throw new Error(`Unknown AI_PROVIDER ${JSON.stringify(process.env.AI_PROVIDER)}. See .env.example.`);
}

/**
 * The AI provider named by `AI_PROVIDER`. Without a SystemClient this returns
 * metadata for consent/UI; the worker supplies one to resolve encrypted keys.
 */
export function configuredAiProvider(): AiProvider {
  if (process.env.AI_PROVIDER === "fake") return fakeAiProvider();
  if (process.env.AI_PROVIDER === "anthropic") {
    const unavailable = async (): Promise<never> => {
      throw new AiProviderError("worker_configuration_required", "The worker resolves Anthropic configuration", {
        transient: false,
      });
    };
    return { name: "anthropic", region: "global", split: unavailable, extract: unavailable };
  }
  if (process.env.AI_PROVIDER === "openai") {
    const unavailable = async (): Promise<never> => {
      throw new AiProviderError("worker_configuration_required", "The worker resolves OpenAI configuration", {
        transient: false,
      });
    };
    return { name: "openai", region: "global", split: unavailable, extract: unavailable };
  }
  throw new Error(`Unknown AI_PROVIDER ${JSON.stringify(process.env.AI_PROVIDER)}. See .env.example.`);
}
