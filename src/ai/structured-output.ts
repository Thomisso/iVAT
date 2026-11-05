import {
  DIRECTIONS,
  DOCUMENT_TYPES,
  validateExtractionPayload,
  VAT_REGIMES,
  type ExtractionPayload,
} from "@/application/extraction-payload";
import { withProviderResponse, type PageRange, type RowRange } from "@/application/ai-provider";

export const EXTRACTION_PROMPT =
  "Extract the Document fields exactly as shown. Use null when a field is not present; never infer tax treatment beyond the proposed VAT Regime. " +
  "For a Credit Note, represent all monetary values as negative amounts and set originalDocumentNumber to the original Document number when it is shown. " +
  "Write amounts with a dot and two decimals (1210.00), dates as YYYY-MM-DD, currency as an ISO 4217 code (CZK) " +
  "and country as an ISO 3166-1 alpha-2 code (CZ), never as a name.";

export const SPLIT_SCHEMA = {
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

export const SPREADSHEET_SPLIT_SCHEMA = {
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
        required: ["sheetName", "firstRow", "lastRow"],
        properties: {
          sheetName: { type: "string" },
          firstRow: { type: "integer", minimum: 1 },
          lastRow: { type: "integer", minimum: 1 },
        },
      },
    },
  },
} as const;

const nullableString = { type: ["string", "null"] } as const;
// Formats the domain validation requires (src/application/extraction-payload.ts).
// Both providers' strict structured outputs honour these simple patterns, so a
// response like `"country": "Czech Republic"` cannot be produced at all.
const AMOUNT_PATTERN = "^-?\\d+\\.\\d{2}$";
const amount = { type: "string", pattern: AMOUNT_PATTERN } as const;
const nullableAmount = { type: ["string", "null"], pattern: AMOUNT_PATTERN } as const;
const nullableDate = { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;
const nullableCountry = { type: ["string", "null"], pattern: "^[A-Z]{2}$" } as const;
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
    country: nullableCountry,
  },
} as const;

export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "documentType", "documentNumber", "issueDate", "taxPointDate", "dueDate", "direction",
    "supplier", "customer", "currency", "rateBreakdown", "totals", "payment", "proposedVatRegime",
    "reverseChargeCode", "originalDocumentNumber",
  ],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    documentType: nullableChoice(DOCUMENT_TYPES),
    documentNumber: nullableString,
    issueDate: nullableDate,
    taxPointDate: nullableDate,
    dueDate: nullableDate,
    direction: nullableChoice(DIRECTIONS),
    supplier: partySchema,
    customer: partySchema,
    currency: { type: ["string", "null"], pattern: "^[A-Z]{3}$" },
    rateBreakdown: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rate", "netAmount", "vatAmount"],
        properties: {
          rate: { type: "number", minimum: 0, maximum: 100 },
          netAmount: amount,
          vatAmount: amount,
        },
      },
    },
    totals: {
      type: "object",
      additionalProperties: false,
      required: ["netAmount", "vatAmount", "grossAmount"],
      properties: { netAmount: nullableAmount, vatAmount: nullableAmount, grossAmount: nullableAmount },
    },
    payment: {
      type: "object",
      additionalProperties: false,
      required: ["variableSymbol", "bankAccount", "iban"],
      properties: { variableSymbol: nullableString, bankAccount: nullableString, iban: nullableString },
    },
    proposedVatRegime: nullableChoice(VAT_REGIMES),
    reverseChargeCode: { type: ["string", "null"], pattern: "^\\d{1,3}$" },
    originalDocumentNumber: nullableString,
  },
} as const;

/** A provider body parsed as JSON, or null when it is not JSON. */
export function parsedOrNull(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Interprets a provider's structured output, keeping its raw body on a refusal. */
export function interpreted<T>(raw: string, interpret: () => T): T {
  try {
    return interpret();
  } catch (error) {
    throw withProviderResponse(error, raw);
  }
}

export function pageRanges(provider: string, value: unknown): PageRange[] {
  if (!value || typeof value !== "object" || !("documents" in value) || !Array.isArray(value.documents)) {
    throw new Error(`${provider} returned an invalid Split`);
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
      throw new Error(`${provider} returned an invalid Split`);
    }
    return { firstPage: range.firstPage as number, lastPage: range.lastPage as number };
  });
}

export function rowRanges(provider: string, value: unknown): RowRange[] {
  if (!value || typeof value !== "object" || !("documents" in value) || !Array.isArray(value.documents)) {
    throw new Error(`${provider} returned an invalid Split`);
  }
  return value.documents.map((range) => {
    if (
      !range ||
      typeof range !== "object" ||
      !("sheetName" in range) ||
      !("firstRow" in range) ||
      !("lastRow" in range) ||
      typeof range.sheetName !== "string" ||
      !Number.isInteger(range.firstRow) ||
      !Number.isInteger(range.lastRow)
    ) {
      throw new Error(`${provider} returned an invalid Split`);
    }
    return {
      sheetName: range.sheetName,
      firstRow: range.firstRow as number,
      lastRow: range.lastRow as number,
    };
  });
}

export function extractionPayload(provider: string, value: unknown): ExtractionPayload {
  if (
    !value || typeof value !== "object" ||
    !("schemaVersion" in value) || value.schemaVersion !== 1 ||
    !("supplier" in value) || !value.supplier || typeof value.supplier !== "object" ||
    !("customer" in value) || !value.customer || typeof value.customer !== "object" ||
    !("rateBreakdown" in value) || !Array.isArray(value.rateBreakdown) ||
    !("totals" in value) || !value.totals || typeof value.totals !== "object" ||
    !("payment" in value) || !value.payment || typeof value.payment !== "object"
  ) {
    throw new Error(`${provider} returned an invalid Extraction payload`);
  }
  const payload = value as ExtractionPayload;
  // The code names the failed check without echoing Document data into job logs.
  const error = validateExtractionPayload(payload);
  if (error) throw new Error(`${provider} returned an invalid Extraction payload (${error})`);
  return payload;
}
