import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AiInput, AiProvider, PageRange } from "@/application/ai-provider";
import type { ExtractionPayload } from "@/application/extraction-payload";
import type { ImageSourceFileFormat } from "@/application/source-files";
import { extractionPayload, pageRanges } from "@/ai/structured-output";

export type GoldenDocument = {
  pages: PageRange;
  expected: ExtractionPayload;
};

export type GoldenCase = {
  id: string;
  sourcePath: string;
  format: ImageSourceFileFormat;
  mediaType: string;
  pageCount: number;
  expectedSplit: PageRange[];
  documents: GoldenDocument[];
};

export type GoldenSet = {
  schemaVersion: 1;
  cases: GoldenCase[];
};

export type Accuracy = { correct: number; total: number; accuracy: number };

export type EvaluationResult = {
  provider: string;
  splitModel: string;
  extractModel: string;
  split: Accuracy;
  fieldAccuracy: Accuracy;
  fields: Record<string, Accuracy>;
};

export type EvaluationReport = {
  evaluatedAt: string;
  cases: number;
  documents: number;
  results: EvaluationResult[];
};

export type EvaluationProvider = { provider: AiProvider; label?: string };
export type ReadBytes = (sourcePath: string) => Promise<Uint8Array>;
export type DocumentBytes = (
  bytes: Uint8Array,
  source: GoldenCase,
  pages: PageRange,
) => Promise<Uint8Array>;

const MEDIA_TYPES: Record<ImageSourceFileFormat, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  heic: "image/heic",
  heif: "image/heif",
};

const EXTRACTION_KEYS = [
  "schemaVersion", "documentType", "documentNumber", "issueDate", "taxPointDate", "dueDate", "direction",
  "supplier", "customer", "currency", "rateBreakdown", "totals", "payment", "proposedVatRegime",
  "originalDocumentNumber",
] as const;
const PARTY_KEYS = ["name", "ico", "vatId", "street", "city", "postalCode", "country"] as const;
const TOTAL_KEYS = ["netAmount", "vatAmount", "grossAmount"] as const;
const PAYMENT_KEYS = ["variableSymbol", "bankAccount", "iban"] as const;
const RATE_KEYS = ["rate", "netAmount", "vatAmount"] as const;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const hasKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => (
  object(value) && keys.every((key) => Object.hasOwn(value, key))
);
const string = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Golden set ${name} must be a non-empty string`);
  return value;
};
const positiveInteger = (value: unknown, name: string): number => {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`Golden set ${name} must be a positive integer`);
  return Number(value);
};

function format(value: unknown): ImageSourceFileFormat {
  if (value === "pdf" || value === "png" || value === "jpeg") return value;
  throw new Error("Golden set format must be pdf, png or jpeg");
}

function validateRanges(ranges: PageRange[], pageCount: number, id: string): PageRange[] {
  let lastPage = 0;
  for (const range of ranges) {
    if (range.firstPage < 1 || range.lastPage < range.firstPage || range.lastPage > pageCount) {
      throw new Error(`Golden set case ${id} has a page range outside its Source File`);
    }
    if (range.firstPage <= lastPage) throw new Error(`Golden set case ${id} has overlapping or unordered page ranges`);
    lastPage = range.lastPage;
  }
  return ranges;
}

function completeExtraction(value: unknown): ExtractionPayload {
  if (
    !hasKeys(value, EXTRACTION_KEYS) ||
    !hasKeys(value.supplier, PARTY_KEYS) ||
    !hasKeys(value.customer, PARTY_KEYS) ||
    !hasKeys(value.totals, TOTAL_KEYS) ||
    !hasKeys(value.payment, PAYMENT_KEYS) ||
    !Array.isArray(value.rateBreakdown) ||
    !value.rateBreakdown.every((line) => hasKeys(line, RATE_KEYS))
  ) {
    throw new Error("Golden set expected file must contain a complete Extraction payload");
  }
  return extractionPayload("Golden set", value);
}

/** Loads and validates a versioned golden-set manifest and its adjacent expected-value files. */
export async function loadGoldenSet(manifestPath: string): Promise<GoldenSet> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  if (!object(manifest) || manifest.schemaVersion !== 1 || !Array.isArray(manifest.cases)) {
    throw new Error("Golden set manifest must have schemaVersion 1 and a cases array");
  }
  const directory = path.dirname(path.resolve(manifestPath));
  const ids = new Set<string>();
  const cases: GoldenCase[] = [];

  for (const [index, value] of manifest.cases.entries()) {
    if (!object(value)) throw new Error(`Golden set case ${index} must be an object`);
    const id = string(value.id, `case ${index} id`);
    if (ids.has(id)) throw new Error(`Golden set case id ${id} is duplicated`);
    ids.add(id);
    const sourceFormat = format(value.format);
    const pageCount = positiveInteger(value.pageCount, `case ${id} pageCount`);
    const expectedSplit = validateRanges(pageRanges("Golden set", { documents: value.expectedSplit }), pageCount, id);
    if (!Array.isArray(value.documents) || value.documents.length !== expectedSplit.length) {
      throw new Error(`Golden set case ${id} needs one expected Extraction per Split range`);
    }
    const documents: GoldenDocument[] = [];
    for (const [documentIndex, document] of value.documents.entries()) {
      if (!object(document)) throw new Error(`Golden set case ${id} Document ${documentIndex} must be an object`);
      const pages = validateRanges(pageRanges("Golden set", { documents: [document.pages] }), pageCount, id)[0];
      const expectedRange = expectedSplit[documentIndex];
      if (pages.firstPage !== expectedRange.firstPage || pages.lastPage !== expectedRange.lastPage) {
        throw new Error(`Golden set case ${id} Document ${documentIndex} does not match expectedSplit`);
      }
      const expectedPath = path.resolve(directory, string(document.expected, `case ${id} expected path`));
      const expected = completeExtraction(JSON.parse(await readFile(expectedPath, "utf8")));
      documents.push({ pages, expected });
    }
    cases.push({
      id,
      sourcePath: path.resolve(directory, string(value.source, `case ${id} source`)),
      format: sourceFormat,
      mediaType: MEDIA_TYPES[sourceFormat],
      pageCount,
      expectedSplit,
      documents,
    });
  }
  return { schemaVersion: 1, cases };
}

const score = (correct: number, total: number): Accuracy => ({
  correct,
  total,
  accuracy: total === 0 ? 0 : correct / total,
});

function sameSplit(actual: PageRange[], expected: PageRange[]): boolean {
  return actual.length === expected.length && actual.every((range, index) => (
    range.firstPage === expected[index].firstPage && range.lastPage === expected[index].lastPage
  ));
}

function leafFields(value: unknown, prefix = ""): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  if (Array.isArray(value)) {
    fields.set(prefix ? `${prefix}.length` : "length", value.length);
    value.forEach((item, index) => {
      for (const [path, leaf] of leafFields(item, prefix ? `${prefix}.${index}` : String(index))) {
        fields.set(path, leaf);
      }
    });
    return fields;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "confidence") continue;
      for (const [path, leaf] of leafFields(item, prefix ? `${prefix}.${key}` : key)) fields.set(path, leaf);
    }
    return fields;
  }
  fields.set(prefix, value);
  return fields;
}

function input(source: GoldenCase, bytes: Uint8Array, pageCount: number): AiInput {
  return {
    format: source.format,
    mediaType: source.mediaType,
    bytes,
    pageCount,
  };
}

/**
 * Runs the real provider seam while scoring Split separately from Extraction.
 * Extraction uses the expected page boundaries so a Split miss does not hide
 * the provider's field-reading quality.
 */
export async function evaluateGoldenSet(
  goldenSet: GoldenSet,
  providers: EvaluationProvider[],
  readBytes: ReadBytes,
  documentBytes: DocumentBytes,
): Promise<EvaluationReport> {
  const results: EvaluationResult[] = [];

  for (const configured of providers) {
    let splitCorrect = 0;
    let splitModel = "";
    let extractModel = "";
    let fieldCorrect = 0;
    let fieldTotal = 0;
    const fields = new Map<string, { correct: number; total: number }>();

    for (const source of goldenSet.cases) {
      const bytes = await readBytes(source.sourcePath);
      const split = await configured.provider.split(input(source, bytes, source.pageCount));
      splitModel ||= split.model;
      const pageDocuments = split.documents.filter((range): range is PageRange => "firstPage" in range);
      if (pageDocuments.length === split.documents.length && sameSplit(pageDocuments, source.expectedSplit)) {
        splitCorrect += 1;
      }

      for (const document of source.documents) {
        const isolated = await documentBytes(bytes, source, document.pages);
        const pageCount = document.pages.lastPage - document.pages.firstPage + 1;
        const extraction = await configured.provider.extract(input(source, isolated, pageCount));
        extractModel ||= extraction.model;
        const expectedFields = leafFields(document.expected);
        const actualFields = leafFields(extraction.payload);
        for (const [path, expected] of expectedFields) {
          const correct = Object.is(actualFields.get(path), expected);
          const field = fields.get(path) ?? { correct: 0, total: 0 };
          field.total += 1;
          fieldTotal += 1;
          if (correct) {
            field.correct += 1;
            fieldCorrect += 1;
          }
          fields.set(path, field);
        }
      }
    }

    results.push({
      provider: configured.label ?? configured.provider.name,
      splitModel,
      extractModel,
      split: score(splitCorrect, goldenSet.cases.length),
      fieldAccuracy: score(fieldCorrect, fieldTotal),
      fields: Object.fromEntries(
        [...fields.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, field]) => [
          path,
          score(field.correct, field.total),
        ]),
      ),
    });
  }

  return {
    evaluatedAt: new Date().toISOString(),
    cases: goldenSet.cases.length,
    documents: goldenSet.cases.reduce((count, source) => count + source.documents.length, 0),
    results,
  };
}

const percent = (accuracy: number) => `${(accuracy * 100).toFixed(2)}%`;

export function formatEvaluationReport(report: EvaluationReport): string {
  const lines = [
    `Golden set: ${report.cases} Source Files, ${report.documents} Documents`,
    `Evaluated at: ${report.evaluatedAt}`,
  ];
  for (const result of report.results) {
    lines.push(
      "",
      `${result.provider} | Split ${result.splitModel} | Extract ${result.extractModel}`,
      `Split accuracy: ${result.split.correct}/${result.split.total} (${percent(result.split.accuracy)})`,
      `Field accuracy: ${result.fieldAccuracy.correct}/${result.fieldAccuracy.total} (${percent(result.fieldAccuracy.accuracy)})`,
    );
    const misses = Object.entries(result.fields).filter(([, accuracy]) => accuracy.correct !== accuracy.total);
    if (misses.length > 0) {
      lines.push("Field misses:");
      for (const [path, accuracy] of misses) {
        lines.push(`  ${path}: ${accuracy.correct}/${accuracy.total} (${percent(accuracy.accuracy)})`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
