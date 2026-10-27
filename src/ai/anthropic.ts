import {
  AiProviderError,
  type AiInput,
  type AiProvider,
  type AiUsage,
} from "@/application/ai-provider";
import type { SystemClient } from "@/application/client";
import { resolvePlatformAiProvider } from "@/application/platform-ai";
import { EXTRACTION_SCHEMA, extractionPayload, pageRanges, SPLIT_SCHEMA } from "./structured-output";

export type AnthropicAiProviderOptions = {
  apiKey: string;
  splitModel: string;
  extractModel: string;
  baseUrl?: string;
};

export class AnthropicProviderError extends AiProviderError {
  readonly status: number | null;

  constructor(message: string, options: { transient: boolean; status?: number; cause?: unknown }) {
    super("anthropic_request_failed", message, { transient: options.transient, cause: options.cause });
    this.name = "AnthropicProviderError";
    this.status = options.status ?? null;
  }
}

function nativeContent(input: AiInput) {
  const source = {
    type: "base64",
    media_type: input.mediaType,
    data: Buffer.from(input.bytes).toString("base64"),
  };
  return input.format === "pdf" ? { type: "document", source } : { type: "image", source };
}

async function structuredMessage(
  options: AnthropicAiProviderOptions,
  model: string,
  input: AiInput,
  prompt: string,
  schema: object,
): Promise<{ model: string; value: unknown; usage?: AiUsage }> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": options.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: [nativeContent(input), { type: "text", text: prompt }] }],
        output_config: { format: { type: "json_schema", schema } },
      }),
    });
  } catch (cause) {
    throw new AnthropicProviderError("Anthropic could not be reached", { transient: true, cause });
  }
  if (!response.ok) {
    const transient = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
    throw new AnthropicProviderError(`Anthropic request failed (${response.status})`, {
      transient,
      status: response.status,
    });
  }
  const result = await response.json() as {
    model?: unknown;
    content?: { type?: unknown; text?: unknown }[];
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  const text = result.content?.find((block) => block.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Anthropic returned no structured output");
  const usage = result.usage;
  return {
    model: typeof result.model === "string" ? result.model : model,
    value: JSON.parse(text),
    ...(typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number"
      ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }
      : {}),
  };
}

export function anthropicAiProvider(options: AnthropicAiProviderOptions): AiProvider {
  return {
    name: "anthropic",
    region: "global",
    async split(input) {
      const result = await structuredMessage(
        options,
        options.splitModel,
        input,
        `Identify the inclusive page range of every Document in this ${input.pageCount}-page Source File.`,
        SPLIT_SCHEMA,
      );
      return {
        model: result.model,
        documents: pageRanges("Anthropic", result.value),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
    async extract(input) {
      const result = await structuredMessage(
        options,
        options.extractModel,
        input,
        "Extract the Document fields exactly as shown. Use null when a field is not present; never infer tax treatment beyond the proposed VAT Regime.",
        EXTRACTION_SCHEMA,
      );
      return {
        model: result.model,
        payload: extractionPayload("Anthropic", result.value),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
  };
}

/** Anthropic provider whose encrypted configuration is resolved per Organization at call time. */
export function platformAnthropicAiProvider(
  system: SystemClient,
  options: { baseUrl?: string } = {},
): AiProvider {
  async function configured(organizationId: string | undefined): Promise<AiProvider> {
    if (!organizationId) {
      throw new AiProviderError("organization_required", "Organization context is required", { transient: false });
    }
    const configuration = await resolvePlatformAiProvider(system, organizationId, "anthropic");
    if (!configuration.ok) {
      throw new AiProviderError(configuration.error, `Anthropic configuration error: ${configuration.error}`, {
        transient: false,
      });
    }
    return anthropicAiProvider({ ...configuration.value, baseUrl: options.baseUrl });
  }

  return {
    name: "anthropic",
    region: "global",
    async split(input, context) {
      return (await configured(context?.organizationId)).split(input, context);
    },
    async extract(input, context) {
      return (await configured(context?.organizationId)).extract(input, context);
    },
  };
}
