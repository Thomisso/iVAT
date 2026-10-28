import {
  DIRECTIONS,
  DOCUMENT_TYPES,
  validateExtractionPayload,
  VAT_REGIMES,
  type ExtractionPayload,
} from "@/application/extraction-payload";
import type { PageRange, RowRange } from "@/application/ai-provider";

export const EXTRACTION_PROMPT =
  "Extract the Document fields exactly as shown. Use null when a field is not present; never infer tax treatment beyond the proposed VAT Regime. " +
  "For a Credit Note, represent all monetary values as negative amounts and set originalDocumentNumber to the original Document number when it is shown.";

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
    reverseChargeCode: nullableString,
    originalDocumentNumber: nullableString,
  },
} as const;

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
  if (validateExtractionPayload(payload)) throw new Error(`${provider} returned an invalid Extraction payload`);
  return payload;
}
