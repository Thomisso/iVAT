import {
  AiProviderError,
  type AiCallContext,
  type AiInput,
  type AiProvider,
  type AiProcessingIssueClassification,
  type AiUsage,
} from "@/application/ai-provider";
import {
  EXTRACTION_PROMPT,
  EXTRACTION_SCHEMA,
  extractionPayload,
  pageRanges,
  rowRanges,
  SPREADSHEET_SPLIT_SCHEMA,
  SPLIT_SCHEMA,
} from "./structured-output";

export type AnthropicAiProviderOptions = {
  apiKey: string;
  splitModel: string;
  extractModel: string;
  baseUrl?: string;
};

export class AnthropicProviderError extends AiProviderError {
  readonly status: number | null;

  constructor(message: string, options: {
    transient: boolean;
    status?: number;
    classification?: AiProcessingIssueClassification;
    platformIntervention?: boolean;
    cause?: unknown;
  }) {
    super("anthropic_request_failed", message, {
      transient: options.transient,
      classification: options.classification,
      platformIntervention: options.platformIntervention,
      cause: options.cause,
    });
    this.name = "AnthropicProviderError";
    this.status = options.status ?? null;
  }
}

function nativeContent(input: AiInput) {
  if (input.text !== undefined) return { type: "text", text: input.text };
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
    const body = await response.json().catch(() => null) as {
      error?: { type?: unknown; message?: unknown; details?: { error_code?: unknown } };
    } | null;
    const errorType = body?.error?.type;
    const errorMessage = body?.error?.message;
    const specifiedSpendLimit = response.status === 400
      && errorType === "invalid_request_error"
      && typeof errorMessage === "string"
      && (
        errorMessage.startsWith("You have reached your specified API usage limits")
        || errorMessage.startsWith("You have reached your specified workspace API usage limits")
      );
    const enforcedSpendCap = response.status === 429
      && errorType === "rate_limit_error"
      && body?.error?.details?.error_code === "enforced_spend_limit_reached"
      && response.headers.get("retry-after") === null;
    const classification = response.status === 401 || errorType === "authentication_error"
      ? "invalid_credentials"
      : response.status === 402 || errorType === "billing_error" || specifiedSpendLimit || enforcedSpendCap
        ? "provider_credits_exhausted"
        : undefined;
    const platformIntervention = classification !== undefined;
    const transient = !platformIntervention
      && (response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500);
    throw new AnthropicProviderError(`Anthropic request failed (${response.status})`, {
      transient,
      status: response.status,
      classification,
      platformIntervention,
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
      const spreadsheet = input.text !== undefined;
      const result = await structuredMessage(
        options,
        options.splitModel,
        input,
        spreadsheet
          ? "Identify every Document in this workbook table. A list normally has one Document per data row; a single invoice may span several rows. Return each inclusive row set and its sheet name."
          : `Identify the inclusive page range of every Document in this ${input.pageCount}-page Source File.`,
        spreadsheet ? SPREADSHEET_SPLIT_SCHEMA : SPLIT_SCHEMA,
      );
      return {
        model: result.model,
        documents: spreadsheet ? rowRanges("Anthropic", result.value) : pageRanges("Anthropic", result.value),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
    async extract(input) {
      const result = await structuredMessage(
        options,
        options.extractModel,
        input,
        EXTRACTION_PROMPT,
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

/** Anthropic provider whose assigned platform configuration is resolved per Company at call time. */
export function platformAnthropicAiProvider(
  options: { baseUrl?: string } = {},
): AiProvider {
  function configured(context: AiCallContext | undefined): AiProvider {
    if (!context?.configuration) {
      throw new AiProviderError("worker_configuration_required", "Anthropic worker configuration is required", {
        transient: false,
      });
    }
    return anthropicAiProvider({ ...context.configuration, baseUrl: options.baseUrl });
  }

  return {
    name: "anthropic",
    region: "global",
    async split(input, context) {
      return configured(context).split(input, context);
    },
    async extract(input, context) {
      return configured(context).extract(input, context);
    },
  };
}
