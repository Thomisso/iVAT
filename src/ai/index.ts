import type { AiProvider } from "@/application/ai-provider";
import { platformAnthropicAiProvider } from "./anthropic";
import { fakeAiProvider } from "./fake";
import { platformOpenAiProvider } from "./openai";

/** Adapters available to the worker; real providers resolve the Company's assigned AI Configuration per job. */
export function configuredAiProviders(): AiProvider[] {
  if (process.env.AI_PROVIDER === "fake") return [fakeAiProvider()];
  if (["platform", "anthropic", "openai"].includes(process.env.AI_PROVIDER ?? "")) {
    return [platformAnthropicAiProvider(), platformOpenAiProvider()];
  }
  throw new Error(`Unknown AI_PROVIDER ${JSON.stringify(process.env.AI_PROVIDER)}. See .env.example.`);
}
