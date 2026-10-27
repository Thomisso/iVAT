import type { AiProvider } from "@/application/ai-provider";
import { fakeAiProvider } from "./fake";

/**
 * The AI provider named by `AI_PROVIDER`. Only `fake` exists so far; the
 * Anthropic and OpenAI adapters follow (#28, #29).
 */
export function configuredAiProvider(): AiProvider {
  if (process.env.AI_PROVIDER === "fake") return fakeAiProvider();
  throw new Error(`Unknown AI_PROVIDER ${JSON.stringify(process.env.AI_PROVIDER)}. See .env.example.`);
}
