import { AiProviderError, type AiInput, type AiProvider, type PageRange } from "@/application/ai-provider";
import type { SystemClient } from "@/application/client";
import {
  DIRECTIONS,
  DOCUMENT_TYPES,
  validateExtractionPayload,
  VAT_REGIMES,
  type ExtractionPayload,
} from "@/application/extraction-payload";
import { resolvePlatformAiProvider } from "@/application/platform-ai";

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

const SPLIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["documents"],
  properties: {
    documents: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["firstPage", "lastPage"],
        properties: {
          firstPage: { type: "integer", minimum: 1 },
          lastPage: { type: "integer", minimum: 1 },
        },
      },
    },
  },
} as const;

const nullableString = { type: ["string", "null"] } as const;
const nullableChoice = (choices: readonly string[]) => ({ type: ["string", "null"], enum: [...choices, null] });
const partySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "ico", "vatId", "street", "city", "postalCode", "country"],
  properties: {
    name: nullableString,
    ico: nullableString,
    vatId: nullableString,
    street: nullableString,
    city: nullableString,
    postalCode: nullableString,
    country: nullableString,
  },
} as const;

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "documentType", "documentNumber", "issueDate", "taxPointDate", "dueDate", "direction",
    "supplier", "customer", "currency", "rateBreakdown", "totals", "payment", "proposedVatRegime",
    "originalDocumentNumber",
  ],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    documentType: nullableChoice(DOCUMENT_TYPES),
    documentNumber: nullableString,
    issueDate: nullableString,
    taxPointDate: nullableString,
    dueDate: nullableString,
    direction: nullableChoice(DIRECTIONS),
    supplier: partySchema,
    customer: partySchema,
    currency: nullableString,
    rateBreakdown: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rate", "netAmount", "vatAmount"],
        properties: {
          rate: { type: "number", minimum: 0, maximum: 100 },
          netAmount: { type: "string" },
          vatAmount: { type: "string" },
        },
      },
    },
    totals: {
      type: "object",
      additionalProperties: false,
      required: ["netAmount", "vatAmount", "grossAmount"],
      properties: { netAmount: nullableString, vatAmount: nullableString, grossAmount: nullableString },
    },
    payment: {
      type: "object",
      additionalProperties: false,
      required: ["variableSymbol", "bankAccount", "iban"],
      properties: { variableSymbol: nullableString, bankAccount: nullableString, iban: nullableString },
    },
    proposedVatRegime: nullableChoice(VAT_REGIMES),
    originalDocumentNumber: nullableString,
  },
} as const;

function nativeContent(input: AiInput) {
  const source = {
    type: "base64",
    media_type: input.mediaType,
    data: Buffer.from(input.bytes).toString("base64"),
  };
  return input.format === "pdf" ? { type: "document", source } : { type: "image", source };
}

function pageRanges(value: unknown): PageRange[] {
  if (!value || typeof value !== "object" || !("documents" in value) || !Array.isArray(value.documents)) {
    throw new Error("Anthropic returned an invalid Split");
  }
  return value.documents.map((range) => {
    if (
      !range ||
      typeof range !== "object" ||
      !("firstPage" in range) ||
      !("lastPage" in range) ||
      !Number.isInteger(range.firstPage) ||
      !Number.isInteger(range.lastPage)
    ) {
      throw new Error("Anthropic returned an invalid Split");
    }
    return { firstPage: range.firstPage as number, lastPage: range.lastPage as number };
  });
}

function extractionPayload(value: unknown): ExtractionPayload {
  if (
    !value || typeof value !== "object" ||
    !("schemaVersion" in value) || value.schemaVersion !== 1 ||
    !("supplier" in value) || !value.supplier || typeof value.supplier !== "object" ||
    !("customer" in value) || !value.customer || typeof value.customer !== "object" ||
    !("rateBreakdown" in value) || !Array.isArray(value.rateBreakdown) ||
    !("totals" in value) || !value.totals || typeof value.totals !== "object" ||
    !("payment" in value) || !value.payment || typeof value.payment !== "object"
  ) {
    throw new Error("Anthropic returned an invalid Extraction payload");
  }
  const payload = value as ExtractionPayload;
  if (validateExtractionPayload(payload)) throw new Error("Anthropic returned an invalid Extraction payload");
  return payload;
}

async function structuredMessage(
  options: AnthropicAiProviderOptions,
  model: string,
  input: AiInput,
  prompt: string,
  schema: object,
): Promise<{ model: string; value: unknown }> {
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
  const result = await response.json() as { model?: unknown; content?: { type?: unknown; text?: unknown }[] };
  const text = result.content?.find((block) => block.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Anthropic returned no structured output");
  return { model: typeof result.model === "string" ? result.model : model, value: JSON.parse(text) };
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
      return { model: result.model, documents: pageRanges(result.value) };
    },
    async extract(input) {
      const result = await structuredMessage(
        options,
        options.extractModel,
        input,
        "Extract the Document fields exactly as shown. Use null when a field is not present; never infer tax treatment beyond the proposed VAT Regime.",
        EXTRACTION_SCHEMA,
      );
      return { model: result.model, payload: extractionPayload(result.value) };
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
