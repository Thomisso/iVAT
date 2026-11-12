import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AiInput, AiProvider, PageRange, SourceRange } from "@/application/ai-provider";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { emptyDocumentPayload } from "@/application/extraction-payload";
import { detectDocumentDirection, type CompanyIdentity } from "@/application/direction-detection";
import type { ImageSourceFileFormat } from "@/application/source-files";
import { extractionPayload, pageRanges } from "@/ai/structured-output";

export type GoldenDocument = {
  pages: PageRange;
  expected: ExtractionPayload;
  /** Human-undecided or unreadable facts are not an assertion of absence. */
  unresolvedFields?: string[];
};

export type GoldenCase = {
  id: string;
  sourcePath: string;
  format: ImageSourceFileFormat;
  mediaType: string;
  pageCount: number;
  company: CompanyIdentity;
  expectedSplit: PageRange[];
  documents: GoldenDocument[];
};

export type GoldenSet = {
  schemaVersion: 1;
  cases: GoldenCase[];
};

export type Accuracy = { correct: number; total: number; accuracy: number };
export type Absence = { correct: number; total: number; hallucinated: number };
export type Normalization = { side: "expected" | "actual"; path: string; before: unknown; after: unknown; reason: string };
export type Classification = { expected: string | null; actual: string | null; correct: boolean };
export type FieldDifference = { path: string; expected: unknown; actual: unknown; kind: "missing" | "hallucinated" | "value" };
export type DocumentEvaluation = {
  caseId: string;
  pages: PageRange;
  raw: ExtractionPayload;
  normalizations: Normalization[];
  direction: Classification;
  vatRegime: Classification;
  differences: FieldDifference[];
  criticalCorrect: boolean;
  requiresCorrection: boolean;
};

export type EvaluationResult = {
  provider: string;
  splitModel: string;
  extractModel: string;
  split: Accuracy;
  splitDetails: { caseId: string; expected: PageRange[]; actual: SourceRange[]; correct: boolean }[];
  fieldAccuracy: Accuracy;
  fields: Record<string, Accuracy>;
  absence: Absence;
  absentFields: Record<string, Absence>;
  criticalAccuracy: Accuracy;
  criticalDocuments: Accuracy;
  correctionFreeDocuments: Accuracy;
  direction: Accuracy;
  vatRegime: Accuracy;
  documents: DocumentEvaluation[];
};

export type EvaluationReport = {
  extractionScope: "isolated_reference_ranges";
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

const EXTRACTION_KEYS = Object.keys(emptyDocumentPayload());
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
  const rates = value.rateBreakdown.map((line) => line.rate);
  if (new Set(rates).size !== rates.length) throw new Error("Golden set reference has ambiguous duplicate Rate Breakdown rates");
  const nullableText = (fact: unknown) => fact === null || typeof fact === "string" && fact.trim().length > 0;
  const { supplier, customer, totals, payment } = value;
  const topLevel = EXTRACTION_KEYS.filter((key) => !["schemaVersion", "supplier", "customer", "rateBreakdown", "totals", "payment"].includes(key));
  if (!topLevel.every((key) => nullableText(value[key]))
    || !PARTY_KEYS.every((key) => nullableText(supplier[key]) && nullableText(customer[key]))
    || !TOTAL_KEYS.every((key) => nullableText(totals[key]))
    || !PAYMENT_KEYS.every((key) => nullableText(payment[key]))
    || !value.rateBreakdown.every((line) => typeof line.rate === "number" && Number.isFinite(line.rate)
      && nullableText(line.netAmount) && nullableText(line.vatAmount))) {
    throw new Error("Golden set reference fact must use its supported type or explicit null for known absence");
  }
  extractionPayload("Golden set", canonicalReference(value));
  return value as ExtractionPayload;
}

function completeReference(unresolvedFields: unknown): void {
  if (unresolvedFields === undefined) return;
  if (!Array.isArray(unresolvedFields) || unresolvedFields.length !== 0) {
    throw new Error("Golden set has an unresolved reference; human confirmation is required before scoring");
  }
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
      completeReference(document.unresolvedFields);
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
      company: companyIdentity(value.company),
      expectedSplit,
      documents,
    });
  }
  return { schemaVersion: 1, cases };
}

function companyIdentity(value: unknown): CompanyIdentity {
  if (!object(value)) throw new Error("Golden set case needs a Company identity for production Direction determination");
  return { ico: string(value.ico, "Company IČO"), vatId: string(value.vatId, "Company VAT ID") };
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
      if (["schemaVersion", "confidence", "sourceLocations", "sourceEvidence", "czkConversion", "partialClaim", "proportionalDeduction", "sourceRateRows", "counterpartyLink", "claimEligibility"].includes(key)) continue;
      for (const [path, leaf] of leafFields(item, prefix ? `${prefix}.${key}` : key)) fields.set(path, leaf);
    }
    return fields;
  }
  fields.set(prefix, value);
  return fields;
}

function criticalField(path: string): boolean {
  return ["documentType", "documentNumber", "issueDate", "taxPointDate", "currency", "originalDocumentNumber"].includes(path)
    || /^(supplier|customer)\.(ico|vatId)$/.test(path)
    || path.startsWith("rateBreakdown.") || path.startsWith("totals.");
}

/** Format equivalence only: no rounding, arithmetic repairs or fuzzy matching. */
function canonicalValue(path: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (/(?:net|vat|gross)Amount$/.test(path)) {
    const compact = value.replace(/\s/g, "");
    const amount = /^(-?)(\d+)(?:[.,](\d{1,2}))?$/.exec(compact);
    if (amount) return `${amount[1]}${amount[2].replace(/^0+(?=\d)/, "")}.${(amount[3] ?? "").padEnd(2, "0")}`;
  }
  if (/(?:issueDate|taxPointDate|dueDate)$/.test(path)) {
    const date = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim());
    if (date) {
      const iso = `${date[3]}-${date[2].padStart(2, "0")}-${date[1].padStart(2, "0")}`;
      const parsed = new Date(`${iso}T00:00:00Z`);
      if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(iso)) return iso;
    }
  }
  if (/^(supplier|customer)\.(ico|vatId)$/.test(path) || path === "payment.iban") return value.replace(/\s/g, "").toUpperCase();
  return value;
}

function canonicalReference(value: unknown, prefix = ""): unknown {
  if (Array.isArray(value)) return value.map((item, index) => canonicalReference(item, `${prefix}.${index}`));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonicalReference(item, prefix ? `${prefix}.${key}` : key)]));
  return canonicalValue(prefix, value);
}

function canonicalFields(payload: ExtractionPayload, side: Normalization["side"], normalizations: Normalization[]): Map<string, unknown> {
  const rateBreakdown = [...payload.rateBreakdown].sort((a, b) => (a.rate ?? -1) - (b.rate ?? -1));
  if (JSON.stringify(rateBreakdown) !== JSON.stringify(payload.rateBreakdown)) {
    normalizations.push({ side, path: "rateBreakdown", before: payload.rateBreakdown, after: rateBreakdown, reason: "rate_order" });
  }
  const fields = leafFields({ ...payload, rateBreakdown });
  for (const [path, before] of fields) {
    const after = canonicalValue(path, before);
    if (!Object.is(before, after)) normalizations.push({ side, path, before, after, reason: "equivalent_format" });
    fields.set(path, after);
  }
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
  // Validate the entire reference before spending even the first provider call.
  for (const source of goldenSet.cases) {
    companyIdentity(source.company);
    for (const document of source.documents) {
      completeReference(document.unresolvedFields);
      completeExtraction(document.expected);
    }
  }
  const results: EvaluationResult[] = [];

  for (const configured of providers) {
    let splitCorrect = 0;
    let splitModel = "";
    let extractModel = "";
    let fieldCorrect = 0;
    let fieldTotal = 0;
    const fields = new Map<string, { correct: number; total: number }>();
    const absentFields: Record<string, Absence> = {};
    const absence: Absence = { correct: 0, total: 0, hallucinated: 0 };
    const documents: DocumentEvaluation[] = [];
    const splitDetails: EvaluationResult["splitDetails"] = [];
    let criticalCorrect = 0;
    let criticalTotal = 0;

    for (const source of goldenSet.cases) {
      const bytes = await readBytes(source.sourcePath);
      const split = await configured.provider.split(input(source, bytes, source.pageCount));
      splitModel ||= split.model;
      const pageDocuments = split.documents.filter((range): range is PageRange => "firstPage" in range);
      const correctSplit = pageDocuments.length === split.documents.length && sameSplit(pageDocuments, source.expectedSplit);
      splitDetails.push({ caseId: source.id, expected: source.expectedSplit, actual: split.documents, correct: correctSplit });
      if (correctSplit) {
        splitCorrect += 1;
      }

      for (const document of source.documents) {
        const isolated = await documentBytes(bytes, source, document.pages);
        const pageCount = document.pages.lastPage - document.pages.firstPage + 1;
        const extraction = await configured.provider.extract(input(source, isolated, pageCount));
        extractModel ||= extraction.model;
        const normalizations: Normalization[] = [];
        const expectedFields = canonicalFields(document.expected, "expected", normalizations);
        const actualDirection = detectDocumentDirection(extraction.payload, source.company);
        const direction = { expected: document.expected.direction, actual: actualDirection, correct: document.expected.direction === actualDirection };
        const vatRegime = { expected: document.expected.proposedVatRegime, actual: extraction.payload.proposedVatRegime, correct: document.expected.proposedVatRegime === extraction.payload.proposedVatRegime };
        const actualFields = canonicalFields({ ...extraction.payload, direction: actualDirection }, "actual", normalizations);
        let documentCorrect = true;
        const differences: FieldDifference[] = [];
        for (const [path, expected] of expectedFields) {
          const correct = Object.is(actualFields.get(path), expected);
          const knownAbsent = expected === null || path === "rateBreakdown.length" && expected === 0;
          if (!correct) differences.push({ path, expected, actual: actualFields.get(path) ?? null,
            kind: actualFields.get(path) === undefined ? "missing" : knownAbsent ? "hallucinated" : "value" });
          if (criticalField(path) && !correct) documentCorrect = false;
          if (knownAbsent) {
            const absent = absentFields[path] ??= { correct: 0, total: 0, hallucinated: 0 };
            for (const target of [absence, absent]) {
              target.total += 1;
              if (correct) target.correct += 1;
              else if (actualFields.has(path) && actualFields.get(path) !== undefined) target.hallucinated += 1;
            }
            continue;
          }
          if (criticalField(path)) {
            criticalTotal += 1;
            if (correct) criticalCorrect += 1;
          }
          const field = fields.get(path) ?? { correct: 0, total: 0 };
          field.total += 1;
          fieldTotal += 1;
          if (correct) {
            field.correct += 1;
            fieldCorrect += 1;
          }
          fields.set(path, field);
        }
        documents.push({ caseId: source.id, pages: document.pages, raw: extraction.payload, normalizations, direction, vatRegime, differences,
          criticalCorrect: documentCorrect, requiresCorrection: differences.length > 0 || !direction.correct || !vatRegime.correct });
      }
    }

    results.push({
      provider: configured.label ?? configured.provider.name,
      splitModel,
      extractModel,
      split: score(splitCorrect, goldenSet.cases.length),
      splitDetails,
      fieldAccuracy: score(fieldCorrect, fieldTotal),
      absence,
      absentFields,
      criticalAccuracy: score(criticalCorrect, criticalTotal),
      criticalDocuments: score(documents.filter((document) => document.criticalCorrect).length, documents.length),
      correctionFreeDocuments: score(documents.filter((document) => !document.requiresCorrection).length, documents.length),
      direction: score(documents.filter((document) => document.direction.expected !== null && document.direction.correct).length,
        documents.filter((document) => document.direction.expected !== null).length),
      vatRegime: score(documents.filter((document) => document.vatRegime.expected !== null && document.vatRegime.correct).length,
        documents.filter((document) => document.vatRegime.expected !== null).length),
      documents,
      fields: Object.fromEntries(
        [...fields.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, field]) => [
          path,
          score(field.correct, field.total),
        ]),
      ),
    });
  }

  return {
    extractionScope: "isolated_reference_ranges",
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
    "Isolated Extraction on human reference ranges; not end-to-end production accuracy",
  ];
  for (const result of report.results) {
    lines.push(
      "",
      `${result.provider} | Split ${result.splitModel} | Extract ${result.extractModel}`,
      `Split accuracy: ${result.split.correct}/${result.split.total} (${percent(result.split.accuracy)})`,
      `Present field accuracy: ${result.fieldAccuracy.correct}/${result.fieldAccuracy.total} (${percent(result.fieldAccuracy.accuracy)})`,
      `Critical financial fields: ${result.criticalAccuracy.correct}/${result.criticalAccuracy.total} (${percent(result.criticalAccuracy.accuracy)})`,
      `Critical financial Documents: ${result.criticalDocuments.correct}/${result.criticalDocuments.total} (${percent(result.criticalDocuments.accuracy)})`,
      `Production Direction: ${result.direction.correct}/${result.direction.total} (${percent(result.direction.accuracy)})`,
      `Proposed VAT Regime: ${result.vatRegime.correct}/${result.vatRegime.total} (${percent(result.vatRegime.accuracy)})`,
      `Correction-free Documents (including ancillary fields): ${result.correctionFreeDocuments.correct}/${result.correctionFreeDocuments.total} (${percent(result.correctionFreeDocuments.accuracy)})`,
      `Known absence: ${result.absence.correct}/${result.absence.total}; hallucinated values: ${result.absence.hallucinated}`,
    );
    const misses = Object.entries(result.fields).filter(([, accuracy]) => accuracy.correct !== accuracy.total);
    if (misses.length > 0) {
      lines.push("Field misses:");
      for (const [path, accuracy] of misses) {
        lines.push(`  ${path}: ${accuracy.correct}/${accuracy.total} (${percent(accuracy.accuracy)})`);
      }
    }
    for (const [path, absence] of Object.entries(result.absentFields)) {
      if (absence.correct !== absence.total) lines.push(`Absence miss ${path}: ${absence.correct}/${absence.total}; hallucinated: ${absence.hallucinated}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
