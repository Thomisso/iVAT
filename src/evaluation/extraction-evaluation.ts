import { readFile } from "node:fs/promises";
import path from "node:path";
import { providerResponseOf, type AiInput, type AiProvider, type AiUsage, type PageRange, type SourceRange } from "@/application/ai-provider";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { emptyDocumentPayload } from "@/application/extraction-payload";
import { detectDocumentDirection, type CompanyIdentity } from "@/application/direction-detection";
import type { ImageSourceFileFormat } from "@/application/source-files";
import { EXTRACTION_PROMPT, SPLIT_SCHEMA, extractionSchema, extractionPayload, pageRanges, pageSplitPrompt } from "@/ai/structured-output";

import { prepareExtractionInput } from "@/application/pdf-extraction";
import { evaluationRevision, hashBytes, hashValue, inputHash, type EvaluationRevision } from "./evaluation-provenance";

export type GoldenDocument = {
  referenceFileHash?: string;
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
  manifestHash?: string;
  schemaVersion: 1;
  cases: GoldenCase[];
};

export type Accuracy = { correct: number; total: number; accuracy: number; missing?: number };
export type Absence = { correct: number; total: number; hallucinated: number; missing?: number };
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

export type CallCoverage = { expected: number; completed: number; failed: number; missing: number };
export type CallProvenance = {
  datasetHash: string;
  revision: EvaluationRevision;
  sourceHash: string | null;
  inputHash: string | null;
  referenceHash: string;
  promptHash: string;
  schemaHash: string | null;
  adapter: string;
  configurationHash: string;
  requestedModel: string | null;
};
export type EvaluationCall = {
  provenance: CallProvenance;
  phase: "split" | "extraction";
  caseId: string;
  pages?: PageRange;
  status: "completed" | "failed" | "missing";
  actualModel: string | null;
  usage: AiUsage | null;
  costUsd: number | null;
  latencyMs: number | null;
  error?: { message: string; rawResponse?: string };
};
export type EvaluationResult = {
  status: "complete" | "partial" | "failed";
  coverage: { split: CallCoverage; extraction: CallCoverage };
  calls: EvaluationCall[];
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
  dataset: GoldenSet;
  provenance: { datasetHash: string; manifestHash: string | null; revision: EvaluationRevision };
  status: "complete" | "partial" | "failed";
  extractionScope: "isolated_reference_ranges";
  evaluatedAt: string;
  cases: number;
  documents: number;
  results: EvaluationResult[];
};

export type EvaluationProvider = { provider: AiProvider; label?: string; identity?: {
  /** Source/version identity, never an API key or a credential-bearing configuration. */
  adapter: string;
  configuration: { splitModel: string; extractModel: string };
} };
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
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
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
      const expectedBytes = await readFile(expectedPath);
      const expected = completeExtraction(JSON.parse(expectedBytes.toString("utf8")));
      documents.push({ pages, expected, referenceFileHash: hashBytes(expectedBytes) });
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
  return { schemaVersion: 1, cases, manifestHash: hashBytes(manifestBytes) };
}

function companyIdentity(value: unknown): CompanyIdentity {
  if (!object(value)) throw new Error("Golden set case needs a Company identity for production Direction determination");
  return { ico: string(value.ico, "Company IČO"), vatId: string(value.vatId, "Company VAT ID") };
}

const score = (correct: number, total: number, missing = 0): Accuracy => ({
  ...(missing ? { missing } : {}),
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
  if (!goldenSet.cases.length || !providers.length) throw new Error("Evaluation needs Source Files and providers");
  // Validate the entire reference before spending even the first provider call.
  for (const source of goldenSet.cases) {
    companyIdentity(source.company);
    for (const document of source.documents) {
      completeReference(document.unresolvedFields);
      completeExtraction(document.expected);
    }
  }
  // Snapshot references and all source/range bytes before calling either provider.
  goldenSet = structuredClone(goldenSet);
  const identities = providers.map(configured => structuredClone(configured.identity ?? {
    adapter: hashValue({ name: configured.provider.name, region: configured.provider.region,
      split: configured.provider.split.toString(), extract: configured.provider.extract.toString() }),
    configuration: { splitModel: null, extractModel: null },
  }));
  const revision = await evaluationRevision();
  type Prepared = { input: AiInput; error?: never } | { input?: never; error: string };
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  const frozen = await Promise.all(goldenSet.cases.map(async (source) => {
    try {
      const bytes = new Uint8Array(await readBytes(source.sourcePath));
      const documents: Prepared[] = await Promise.all(source.documents.map(async (document): Promise<Prepared> => {
        try {
          const isolated = new Uint8Array(await documentBytes(bytes.slice(), structuredClone(source), structuredClone(document.pages)));
          return { input: await prepareExtractionInput(input(source, isolated, document.pages.lastPage - document.pages.firstPage + 1)) };
        } catch (error) { return { error: message(error) }; }
      }));
      return { split: { input: input(source, bytes, source.pageCount) } as Prepared, documents, sourceHash: hashBytes(bytes) };
    } catch (error) {
      const missing = { error: message(error) } as Prepared;
      return { split: missing, documents: source.documents.map(() => missing), sourceHash: null };
    }
  }));
  const datasetHash = hashValue({ manifestHash: goldenSet.manifestHash ?? null,
    cases: goldenSet.cases.map((source, index) => ({ ...source, sourcePath: undefined, sourceHash: frozen[index].sourceHash })) });
  const results: EvaluationResult[] = [];

  for (const [providerIndex, configured] of providers.entries()) {
    let splitCorrect = 0;
    let fieldCorrect = 0;
    let fieldTotal = 0;
    const fields = new Map<string, { correct: number; total: number; missing?: number }>();
    const calls: EvaluationCall[] = [];
    let missingFields = 0;
    let missingCritical = 0;
    const capture = async <T extends { model: string; modelReported?: boolean; usage?: AiUsage }>(
      phase: EvaluationCall["phase"], source: GoldenCase, prepared: Prepared, operation: (callInput: AiInput) => Promise<T>, document?: GoldenDocument,
    ): Promise<T | null> => {
      const callInput = prepared.input;
      const identity = identities[providerIndex];
      const pages = document?.pages;
      const provenance: CallProvenance = {
        datasetHash, revision, sourceHash: frozen[goldenSet.cases.indexOf(source)].sourceHash,
        inputHash: callInput ? inputHash(callInput) : null,
        referenceHash: hashValue(document ? { company: source.company, document } : { company: source.company, expectedSplit: source.expectedSplit, documents: source.documents }),
        promptHash: hashBytes(phase === "split" ? pageSplitPrompt(source.pageCount) : EXTRACTION_PROMPT),
        schemaHash: callInput ? hashValue(phase === "split" ? SPLIT_SCHEMA : extractionSchema(callInput)) : null,
        adapter: identity.adapter, configurationHash: hashValue(identity.configuration),
        requestedModel: phase === "split" ? identity.configuration.splitModel : identity.configuration.extractModel,
      };
      if (!callInput) {
        calls.push({ provenance, phase, caseId: source.id, ...(pages ? { pages } : {}), status: "missing", actualModel: null,
          usage: null, costUsd: null, latencyMs: null, error: { message: prepared.error } });
        return null;
      }
      const start = performance.now();
      try {
        const result = structuredClone(await operation(structuredClone(callInput)));
        calls.push({ provenance, phase, caseId: source.id, ...(pages ? { pages } : {}), status: "completed", actualModel: result.modelReported === false ? null : result.model,
          usage: result.usage ?? null, costUsd: result.usage?.costUsd ?? null, latencyMs: performance.now() - start });
        return result;
      } catch (error) {
        const rawResponse = providerResponseOf(error);
        let returnedModel: string | null = null;
        if (rawResponse) {
          try {
            const response: unknown = JSON.parse(rawResponse);
            if (object(response) && typeof response.model === "string") returnedModel = response.model;
          } catch { /* A non-JSON failure body remains private diagnostic evidence. */ }
        }
        calls.push({ provenance, phase, caseId: source.id, ...(pages ? { pages } : {}), status: "failed", actualModel: returnedModel,
          usage: null, costUsd: null, latencyMs: performance.now() - start,
          error: { message: error instanceof Error ? error.message : String(error), ...(rawResponse ? { rawResponse } : {}) } });
        return null;
      }
    };
    const absentFields: Record<string, Absence> = {};
    const absence: Absence = { correct: 0, total: 0, hallucinated: 0 };
    const documents: DocumentEvaluation[] = [];
    const splitDetails: EvaluationResult["splitDetails"] = [];
    let criticalCorrect = 0;
    let criticalTotal = 0;

    for (const [sourceIndex, source] of goldenSet.cases.entries()) {
      const split = await capture("split", source, frozen[sourceIndex].split, input => configured.provider.split(input));
      if (split) {
        const pageDocuments = split.documents.filter((range): range is PageRange => "firstPage" in range);
        const correctSplit = pageDocuments.length === split.documents.length && sameSplit(pageDocuments, source.expectedSplit);
        splitDetails.push({ caseId: source.id, expected: source.expectedSplit, actual: split.documents, correct: correctSplit });
        if (correctSplit) splitCorrect += 1;
      }

      for (const [documentIndex, document] of source.documents.entries()) {
        const extractionInput = frozen[sourceIndex].documents[documentIndex];
        const extraction = await capture("extraction", source, extractionInput,
          input => configured.provider.extract(input), document);
        if (!extraction) {
          for (const [fieldPath, expected] of canonicalFields(document.expected, "expected", [])) {
            if (expected === null || fieldPath === "rateBreakdown.length" && expected === 0) {
              const absent = absentFields[fieldPath] ??= { correct: 0, total: 0, hallucinated: 0 };
              for (const target of [absence, absent]) {
                target.total += 1;
                target.missing = (target.missing ?? 0) + 1;
              }
              continue;
            }
            const field = fields.get(fieldPath) ?? { correct: 0, total: 0 };
            field.total += 1;
            field.missing = (field.missing ?? 0) + 1;
            fields.set(fieldPath, field);
            fieldTotal += 1;
            missingFields += 1;
            if (criticalField(fieldPath)) { criticalTotal += 1; missingCritical += 1; }
          }
          continue;
        }
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

    const coverage = Object.fromEntries((["split", "extraction"] as const).map((phase) => [phase, {
      expected: phase === "split" ? goldenSet.cases.length : goldenSet.cases.reduce((sum, source) => sum + source.documents.length, 0),
      completed: calls.filter(call => call.phase === phase && call.status === "completed").length,
      failed: calls.filter(call => call.phase === phase && call.status === "failed").length,
      missing: calls.filter(call => call.phase === phase && call.status === "missing").length,
    }])) as EvaluationResult["coverage"];
    const totalDocuments = coverage.extraction.expected;
    const missingDocuments = totalDocuments - documents.length;
    results.push({
      status: calls.every(call => call.status === "completed") ? "complete" : calls.some(call => call.status === "completed") ? "partial" : "failed",
      calls, coverage,
      provider: configured.label ?? configured.provider.name,
      splitModel: modelSummary(calls, "split"),
      extractModel: modelSummary(calls, "extraction"),
      split: score(splitCorrect, goldenSet.cases.length, coverage.split.failed + coverage.split.missing),
      splitDetails,
      fieldAccuracy: score(fieldCorrect, fieldTotal, missingFields),
      absence,
      absentFields,
      criticalAccuracy: score(criticalCorrect, criticalTotal, missingCritical),
      criticalDocuments: score(documents.filter((document) => document.criticalCorrect).length, totalDocuments, missingDocuments),
      correctionFreeDocuments: score(documents.filter((document) => !document.requiresCorrection).length, totalDocuments, missingDocuments),
      direction: score(documents.filter((document) => document.direction.expected !== null && document.direction.correct).length,
        goldenSet.cases.flatMap(source => source.documents).filter(document => document.expected.direction !== null).length,
        goldenSet.cases.flatMap(source => source.documents).filter(document => document.expected.direction !== null).length - documents.filter(document => document.direction.expected !== null).length),
      vatRegime: score(documents.filter((document) => document.vatRegime.expected !== null && document.vatRegime.correct).length,
        goldenSet.cases.flatMap(source => source.documents).filter(document => document.expected.proposedVatRegime !== null).length,
        goldenSet.cases.flatMap(source => source.documents).filter(document => document.expected.proposedVatRegime !== null).length - documents.filter(document => document.vatRegime.expected !== null).length),
      documents,
      fields: Object.fromEntries(
        [...fields.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, field]) => [
          path,
          score(field.correct, field.total, field.missing),
        ]),
      ),
    });
  }

  return {
    dataset: goldenSet,
    provenance: { datasetHash, manifestHash: goldenSet.manifestHash ?? null, revision },
    status: results.every(result => result.status === "complete") ? "complete" : results.some(result => result.status !== "failed") ? "partial" : "failed",
    extractionScope: "isolated_reference_ranges",
    evaluatedAt: new Date().toISOString(),
    cases: goldenSet.cases.length,
    documents: goldenSet.cases.reduce((count, source) => count + source.documents.length, 0),
    results,
  };
}

function modelSummary(calls: EvaluationCall[], phase: EvaluationCall["phase"]): string {
  const models = [...new Set(calls.filter(call => call.phase === phase && call.actualModel !== null).map(call => call.actualModel!))];
  return models.length > 1 ? `mixed: ${models.join(", ")}` : models[0] ?? "unavailable";
}

const percent = (accuracy: number) => `${(accuracy * 100).toFixed(2)}%`;

/** Deliberate allow-list: never spread the private report into public output. */
export function safeEvaluationSummary(report: EvaluationReport) {
  const safeField = (key: string) => /^(documentType|documentNumber|issueDate|taxPointDate|dueDate|direction|currency|proposedVatRegime|reverseChargeCode|originalDocumentNumber)$/.test(key)
    || /^(supplier|customer)\.(name|ico|vatId|street|city|postalCode|country)$/.test(key)
    || /^totals\.(netAmount|vatAmount|grossAmount)$/.test(key)
    || /^payment\.(variableSymbol|bankAccount|iban)$/.test(key)
    || /^rateBreakdown\.(length|\d+\.(rate|netAmount|vatAmount))$/.test(key);
  const safeFields = <T>(fields: Record<string, T>) => Object.fromEntries(Object.entries(fields).filter(([key]) => safeField(key)));
  return {
    status: report.status, extractionScope: report.extractionScope,
    evaluatedAt: report.evaluatedAt, cases: report.cases, documents: report.documents,
    datasetHash: report.provenance.datasetHash,
    results: report.results.map((result, index) => ({
      provider: ["anthropic", "openai"].includes(result.provider) ? result.provider : `Provider ${index + 1}`,
      status: result.status, coverage: result.coverage,
      returnedModels: {
        split: new Set(result.calls.filter(call => call.phase === "split" && call.actualModel !== null).map(call => call.actualModel)).size,
        extraction: new Set(result.calls.filter(call => call.phase === "extraction" && call.actualModel !== null).map(call => call.actualModel)).size,
      },
      split: result.split, fieldAccuracy: result.fieldAccuracy,
      criticalAccuracy: result.criticalAccuracy, criticalDocuments: result.criticalDocuments,
      correctionFreeDocuments: result.correctionFreeDocuments, direction: result.direction, vatRegime: result.vatRegime,
      absence: result.absence, fields: safeFields(result.fields), absentFields: safeFields(result.absentFields),
    })),
  };
}

export function formatEvaluationReport(privateReport: EvaluationReport): string {
  const report = safeEvaluationSummary(privateReport);
  const lines = [
    `Golden set: ${report.cases} Source Files, ${report.documents} Documents`,
    `Run status: ${report.status}`,
    `Evaluated at: ${report.evaluatedAt}`,
    "Isolated Extraction on human reference ranges; not end-to-end production accuracy",
    "Missing measurements remain in denominators and are not observed correctness or zero cost.",
  ];
  for (const result of report.results) {
    lines.push(
      "",
      `${result.provider} | Split models: ${result.returnedModels.split} | Extract models: ${result.returnedModels.extraction}`,
      `Split coverage: ${result.coverage.split.completed}/${result.coverage.split.expected}; failed: ${result.coverage.split.failed}; missing: ${result.coverage.split.missing}`,
      `Extraction coverage: ${result.coverage.extraction.completed}/${result.coverage.extraction.expected}; failed: ${result.coverage.extraction.failed}; missing: ${result.coverage.extraction.missing}`,
      `Split accuracy: ${result.split.correct}/${result.split.total} (${percent(result.split.accuracy)})`,
      `Present field accuracy: ${result.fieldAccuracy.correct}/${result.fieldAccuracy.total} (${percent(result.fieldAccuracy.accuracy)})`,
      `Critical financial fields: ${result.criticalAccuracy.correct}/${result.criticalAccuracy.total} (${percent(result.criticalAccuracy.accuracy)})`,
      `Critical financial Documents: ${result.criticalDocuments.correct}/${result.criticalDocuments.total} (${percent(result.criticalDocuments.accuracy)})`,
      `Production Direction: ${result.direction.correct}/${result.direction.total} (${percent(result.direction.accuracy)})`,
      `Proposed VAT Regime: ${result.vatRegime.correct}/${result.vatRegime.total} (${percent(result.vatRegime.accuracy)})`,
      `Correction-free Documents (including ancillary fields): ${result.correctionFreeDocuments.correct}/${result.correctionFreeDocuments.total} (${percent(result.correctionFreeDocuments.accuracy)})`,
      `Known absence: ${result.absence.correct}/${result.absence.total}; hallucinated values: ${result.absence.hallucinated}; missing: ${result.absence.missing ?? 0}`,
    );
    for (const [path, accuracy] of Object.entries(result.fields)) {
      if (accuracy.correct !== accuracy.total) lines.push(`  ${path}: ${accuracy.correct}/${accuracy.total} (${percent(accuracy.accuracy)}); missing: ${accuracy.missing ?? 0}`);
    }
    for (const [path, absence] of Object.entries(result.absentFields)) {
      if (absence.correct !== absence.total) lines.push(`Absence miss ${path}: ${absence.correct}/${absence.total}; hallucinated: ${absence.hallucinated}; missing: ${absence.missing ?? 0}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
