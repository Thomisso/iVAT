import { prepareExtractionInput } from "@/application/pdf-extraction";
import {
  AiProviderError,
  withProviderResponse,
  type AiCallContext,
  type AiGenerationLimits,
  type AiInput,
  type AiProvider,
  type AiProcessingIssueClassification,
  type AiUsage,
} from "@/application/ai-provider";
import {
  EXTRACTION_PROMPT,
  extractionSchema,
  extractionPayload,
  interpreted,
  pageRanges,
  pageSplitPrompt,
  parsedOrNull,
  rowRanges,
  SPREADSHEET_SPLIT_SCHEMA,
  SPLIT_SCHEMA,
} from "./structured-output";

export type OpenAiProviderOptions = {
  apiKey: string;
  splitModel: string;
  extractModel: string;
  baseUrl?: string;
};

export class OpenAiProviderError extends AiProviderError {
  readonly status: number | null;

  constructor(message: string, options: {
    transient: boolean;
    status?: number;
    classification?: AiProcessingIssueClassification;
    platformIntervention?: boolean;
    cause?: unknown;
  }) {
    super("openai_request_failed", message, {
      transient: options.transient,
      classification: options.classification,
      platformIntervention: options.platformIntervention,
      cause: options.cause,
    });
    this.name = "OpenAiProviderError";
    this.status = options.status ?? null;
  }
}

function nativeContent(input: AiInput) {
  if (input.pageImages) return input.pageImages.flatMap((page, index) => [
    { type: "input_text", text: `Page ${index + 1} of ${input.pageCount} (full oriented page, ${page.width} x ${page.height} pixels).` },
    { type: "input_image", image_url: `data:${page.mediaType};base64,${Buffer.from(page.bytes).toString("base64")}`, detail: "high" },
  ]);
  if (input.text !== undefined) return [{ type: "input_text", text: input.text }];
  const base64 = Buffer.from(input.bytes).toString("base64");
  if (input.format === "pdf") return [{ type: "input_file", filename: "source-file.pdf",
    file_data: `data:${input.mediaType};base64,${base64}` }];
  return [{ type: "input_image", image_url: `data:${input.mediaType};base64,${base64}`, detail: "high" }];
}

async function structuredResponse(
  options: OpenAiProviderOptions,
  model: string,
  input: AiInput,
  prompt: string,
  schemaName: string,
  schema: object,
  limits?: AiGenerationLimits,
): Promise<{ model: string; modelReported?: boolean; value: unknown; usage?: AiUsage; raw: string }> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl ?? "https://api.openai.com/v1"}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        ...(limits ? { max_output_tokens: limits.maxOutputTokens } : {}),
        input: [{
          role: "user",
          content: [...nativeContent(input), { type: "input_text", text: prompt }],
        }],
        text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
      }),
    });
  } catch (cause) {
    throw new OpenAiProviderError("OpenAI could not be reached", { transient: true, cause });
  }
  const raw = await response.text().catch(() => "");
  const fail = (error: unknown) => withProviderResponse(error, raw);
  if (!response.ok) {
    const body = parsedOrNull(raw) as { error?: { code?: unknown } } | null;
    const errorCode = body?.error?.code;
    const creditsExhausted = errorCode === "insufficient_quota" || errorCode === "billing_hard_limit_reached";
    const classification = response.status === 401
      ? "invalid_credentials"
      : creditsExhausted
        ? "provider_credits_exhausted"
        : undefined;
    const platformIntervention = classification !== undefined;
    const transient = !platformIntervention
      && (response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500);
    throw fail(new OpenAiProviderError(`OpenAI request failed (${response.status})`, {
      transient,
      status: response.status,
      classification,
      platformIntervention,
    }));
  }
  let result: {
    model?: unknown;
    status?: unknown;
    output?: { type?: unknown; content?: { type?: unknown; text?: unknown; refusal?: unknown }[] }[];
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  try {
    result = JSON.parse(raw);
  } catch (error) {
    throw fail(error);
  }
  if (result.status !== undefined && result.status !== "completed") {
    throw fail(new OpenAiProviderError(`OpenAI response did not complete (${String(result.status)})`, { transient: true }));
  }
  const text = result.output
    ?.find((item) => item.type === "message")
    ?.content?.find((content) => content.type === "output_text")?.text;
  if (typeof text !== "string") {
    throw fail(new OpenAiProviderError("OpenAI returned no structured output", { transient: false }));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw fail(error);
  }
  const usage = result.usage;
  return {
    raw,
    model: typeof result.model === "string" ? result.model : model,
    ...(typeof result.model !== "string" ? { modelReported: false } : {}),
    value,
    ...(typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number"
      ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }
      : {}),
  };
}

export function openAiProvider(options: OpenAiProviderOptions): AiProvider {
  return {
    name: "openai",
    region: "global",
    async split(input, _context, limits) {
      const spreadsheet = input.text !== undefined;
      const result = await structuredResponse(
        options,
        options.splitModel,
        input,
        spreadsheet
          ? "Identify every Document in this workbook table. A list normally has one Document per data row; a single invoice may span several rows. Return each inclusive row set and its sheet name."
          : pageSplitPrompt(input.pageCount),
        "ivat_split",
        spreadsheet ? SPREADSHEET_SPLIT_SCHEMA : SPLIT_SCHEMA,
        limits,
      );
      return {
        model: result.model,
        ...(result.modelReported === false ? { modelReported: false } : {}),
        documents: interpreted(result.raw, () => spreadsheet ? rowRanges("OpenAI", result.value) : pageRanges("OpenAI", result.value)),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
    async extract(input, _context, limits) {
      input = await prepareExtractionInput(input);
      const result = await structuredResponse(
        options,
        options.extractModel,
        input,
        EXTRACTION_PROMPT,
        "ivat_extraction",
        extractionSchema(input),
        limits,
      );
      return {
        model: result.model,
        ...(result.modelReported === false ? { modelReported: false } : {}),
        payload: interpreted(result.raw, () => extractionPayload("OpenAI", result.value, input)),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
  };
}

/** OpenAI provider whose assigned platform configuration is resolved per Company at call time. */
export function platformOpenAiProvider(
  options: { baseUrl?: string } = {},
): AiProvider {
  function configured(context: AiCallContext | undefined): AiProvider {
    if (!context?.configuration) {
      throw new AiProviderError("worker_configuration_required", "OpenAI worker configuration is required", {
        transient: false,
      });
    }
    return openAiProvider({ ...context.configuration, baseUrl: options.baseUrl });
  }

  return {
    name: "openai",
    region: "global",
    async split(input, context, limits) {
      return configured(context).split(input, context, limits);
    },
    async extract(input, context, limits) {
      return configured(context).extract(input, context, limits);
    },
  };
}
