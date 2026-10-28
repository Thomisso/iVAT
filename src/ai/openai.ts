import { AiProviderError, type AiInput, type AiProvider } from "@/application/ai-provider";
import type { SystemClient } from "@/application/client";
import { resolvePlatformAiProvider } from "@/application/platform-ai";
import {
  EXTRACTION_SCHEMA,
  extractionPayload,
  pageRanges,
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

  constructor(message: string, options: { transient: boolean; status?: number; cause?: unknown }) {
    super("openai_request_failed", message, { transient: options.transient, cause: options.cause });
    this.name = "OpenAiProviderError";
    this.status = options.status ?? null;
  }
}

function nativeContent(input: AiInput) {
  if (input.text !== undefined) return { type: "input_text", text: input.text };
  const base64 = Buffer.from(input.bytes).toString("base64");
  if (input.format === "pdf") {
    return {
      type: "input_file",
      filename: "source-file.pdf",
      file_data: `data:${input.mediaType};base64,${base64}`,
    };
  }
  return {
    type: "input_image",
    image_url: `data:${input.mediaType};base64,${base64}`,
    detail: "high",
  };
}

async function structuredResponse(
  options: OpenAiProviderOptions,
  model: string,
  input: AiInput,
  prompt: string,
  schemaName: string,
  schema: object,
): Promise<{ model: string; value: unknown }> {
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
        input: [{
          role: "user",
          content: [nativeContent(input), { type: "input_text", text: prompt }],
        }],
        text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
      }),
    });
  } catch (cause) {
    throw new OpenAiProviderError("OpenAI could not be reached", { transient: true, cause });
  }
  if (!response.ok) {
    const transient = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
    throw new OpenAiProviderError(`OpenAI request failed (${response.status})`, {
      transient,
      status: response.status,
    });
  }
  const result = await response.json() as {
    model?: unknown;
    status?: unknown;
    output?: { type?: unknown; content?: { type?: unknown; text?: unknown; refusal?: unknown }[] }[];
  };
  if (result.status !== undefined && result.status !== "completed") {
    throw new OpenAiProviderError(`OpenAI response did not complete (${String(result.status)})`, { transient: true });
  }
  const text = result.output
    ?.find((item) => item.type === "message")
    ?.content?.find((content) => content.type === "output_text")?.text;
  if (typeof text !== "string") {
    throw new OpenAiProviderError("OpenAI returned no structured output", { transient: false });
  }
  return { model: typeof result.model === "string" ? result.model : model, value: JSON.parse(text) };
}

export function openAiProvider(options: OpenAiProviderOptions): AiProvider {
  return {
    name: "openai",
    region: "global",
    async split(input) {
      const spreadsheet = input.text !== undefined;
      const result = await structuredResponse(
        options,
        options.splitModel,
        input,
        spreadsheet
          ? "Identify every Document in this workbook table. A list normally has one Document per data row; a single invoice may span several rows. Return each inclusive row set and its sheet name."
          : `Identify the inclusive page range of every Document in this ${input.pageCount}-page Source File.`,
        "ivat_split",
        spreadsheet ? SPREADSHEET_SPLIT_SCHEMA : SPLIT_SCHEMA,
      );
      return {
        model: result.model,
        documents: spreadsheet ? rowRanges("OpenAI", result.value) : pageRanges("OpenAI", result.value),
      };
    },
    async extract(input) {
      const result = await structuredResponse(
        options,
        options.extractModel,
        input,
        "Extract the Document fields exactly as shown. Use null when a field is not present; never infer tax treatment beyond the proposed VAT Regime.",
        "ivat_extraction",
        EXTRACTION_SCHEMA,
      );
      return { model: result.model, payload: extractionPayload("OpenAI", result.value) };
    },
  };
}

/** OpenAI provider whose encrypted configuration is resolved per Organization at call time. */
export function platformOpenAiProvider(
  system: SystemClient,
  options: { baseUrl?: string } = {},
): AiProvider {
  async function configured(organizationId: string | undefined): Promise<AiProvider> {
    if (!organizationId) {
      throw new AiProviderError("organization_required", "Organization context is required", { transient: false });
    }
    const configuration = await resolvePlatformAiProvider(system, organizationId, "openai");
    if (!configuration.ok) {
      throw new AiProviderError(configuration.error, `OpenAI configuration error: ${configuration.error}`, {
        transient: false,
      });
    }
    return openAiProvider({ ...configuration.value, baseUrl: options.baseUrl });
  }

  return {
    name: "openai",
    region: "global",
    async split(input, context) {
      return (await configured(context?.organizationId)).split(input, context);
    },
    async extract(input, context) {
      return (await configured(context?.organizationId)).extract(input, context);
    },
  };
}
