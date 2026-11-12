import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { anthropicAiProvider } from "@/ai/anthropic";
import { openAiProvider } from "@/ai/openai";
import { PDFDocument } from "pdf-lib";
import { pdfPages } from "@/application/source-files";
import { withProviderResponse, type AiProvider } from "@/application/ai-provider";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { emptyDocumentPayload } from "@/application/extraction-payload";
import {
  evaluateGoldenSet,
  formatEvaluationReport,
  loadGoldenSet,
  type GoldenSet,
} from "@/evaluation/extraction-evaluation";

const expectedExtraction: ExtractionPayload = {
  schemaVersion: 1,
  documentType: "invoice",
  documentNumber: "FV-100",
  issueDate: "2026-10-01",
  taxPointDate: "2026-10-01",
  dueDate: null,
  direction: "incoming",
  supplier: {
    name: "Dodavatel s.r.o.",
    ico: "27082440",
    vatId: "CZ27082440",
    street: null,
    city: "Praha",
    postalCode: null,
    country: "CZ",
  },
  customer: {
    name: "Odběratel s.r.o.",
    ico: null,
    vatId: "CZ12345678",
    street: null,
    city: null,
    postalCode: null,
    country: "CZ",
  },
  currency: "CZK",
  rateBreakdown: [{ rate: 21, netAmount: "1000.00", vatAmount: "210.00" }],
  totals: { netAmount: "1000.00", vatAmount: "210.00", grossAmount: "1210.00" },
  payment: { variableSymbol: "100", bankAccount: null, iban: null },
  proposedVatRegime: "domestic",
  reverseChargeCode: null,
  originalDocumentNumber: null,
};

const goldenSet: GoldenSet = {
  schemaVersion: 1,
  cases: [{
    id: "two-documents",
    sourcePath: "/golden/two-documents.png",
    format: "png",
    mediaType: "image/png",
    pageCount: 2,
    company: { ico: "12345678", vatId: "CZ12345678" },
    expectedSplit: [
      { firstPage: 1, lastPage: 1 },
      { firstPage: 2, lastPage: 2 },
    ],
    documents: [
      { pages: { firstPage: 1, lastPage: 1 }, expected: expectedExtraction },
      { pages: { firstPage: 2, lastPage: 2 }, expected: { ...expectedExtraction, documentNumber: "FV-200" } },
    ],
  }],
};

function scriptedProvider(): AiProvider {
  let extraction = 0;
  return {
    name: "scripted",
    region: "local",
    async split() {
      return { model: "split-v1", documents: goldenSet.cases[0].expectedSplit };
    },
    async extract() {
      extraction += 1;
      return {
        model: "extract-v2",
        payload: extraction === 1
          ? expectedExtraction
          : { ...expectedExtraction, documentNumber: "wrong", currency: "EUR" },
      };
    },
  };
}

async function evaluatePayload(actual: ExtractionPayload, expected = expectedExtraction) {
  const provider = scriptedProvider();
  provider.extract = async () => ({ model: "synthetic-extract", payload: actual });
  return evaluateGoldenSet({
    schemaVersion: 1,
    cases: [{ ...goldenSet.cases[0], pageCount: 1, expectedSplit: [{ firstPage: 1, lastPage: 1 }],
      documents: [{ pages: { firstPage: 1, lastPage: 1 }, expected }] }],
  }, [{ provider }], async () => new Uint8Array([1]), async (bytes) => bytes);
}

describe("Extraction evaluation", () => {
  it("freezes identical source bytes and reference facts before either provider can mutate them", async () => {
    const reference = structuredClone(goldenSet);
    const received: number[][] = [];
    let reads = 0;
    const first = scriptedProvider();
    first.split = async (input) => {
      received.push([...input.bytes]);
      input.bytes[0] = 99;
      reference.cases[0].documents[0].expected.documentNumber = "mutated-after-freeze";
      return { model: "split-a", documents: reference.cases[0].expectedSplit };
    };
    const second = scriptedProvider();
    second.split = async (input) => {
      received.push([...input.bytes]);
      return { model: "split-b", documents: reference.cases[0].expectedSplit };
    };
    const report = await evaluateGoldenSet(reference, [{ provider: first }, { provider: second }],
      async () => new Uint8Array([++reads, 80]), async (bytes) => bytes);
    expect(received).toEqual([[1, 80], [1, 80]]);
    expect(reads).toBe(1);
    expect(report.results[0].fields.documentNumber).toEqual({ correct: 1, total: 2, accuracy: 0.5 });
    expect(report.results[1].fields.documentNumber).toEqual({ correct: 1, total: 2, accuracy: 0.5 });
  });

  it("binds every call to frozen PDF derivatives, references, prompt, revision and the actual returned model", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([72, 72]);
    pdf.addPage([90, 72]);
    const bytes = await pdf.save();
    const seen: { phase: string; bytes: number[]; image?: number[]; dimensions?: number[] }[] = [];
    const provider = (name: string): AiProvider => {
      let call = 0;
      return {
        name, region: "local",
        async split(input) {
          seen.push({ phase: "split", bytes: [...input.bytes] });
          return { model: `${name}-split-returned`, documents: goldenSet.cases[0].expectedSplit };
        },
        async extract(input) {
          seen.push({ phase: "extraction", bytes: [...input.bytes], image: [...(input.pageImages?.[0].bytes ?? [])], dimensions: [input.pageImages?.[0].width ?? 0, input.pageImages?.[0].height ?? 0] });
          if (input.pageImages) input.pageImages[0].bytes[0] = 99;
          return { model: `${name}-extract-${++call}`, payload: call === 1 ? expectedExtraction : { ...expectedExtraction, documentNumber: "FV-200" } };
        },
      };
    };
    const pdfSet: GoldenSet = { ...goldenSet, cases: [{ ...goldenSet.cases[0], format: "pdf", mediaType: "application/pdf" }] };
    const report = await evaluateGoldenSet(pdfSet, [
      { provider: provider("first"), identity: { adapter: "fake-v1", configuration: { splitModel: "requested-split", extractModel: "requested-extract" } } },
      { provider: provider("second"), identity: { adapter: "fake-v2", configuration: { splitModel: "requested-split", extractModel: "requested-extract" } } },
    ], async () => bytes, async (source, _case, pages) => pdfPages(source, pages));
    expect(seen.slice(0, 3)).toEqual(seen.slice(3));
    expect(seen[1].image?.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect([seen[1].dimensions, seen[2].dimensions]).toEqual([[144, 144], [180, 144]]);
    expect(seen[1].image).not.toEqual(seen[2].image);
    expect(report.provenance).toMatchObject({ datasetHash: expect.stringMatching(/^[a-f0-9]{64}$/), revision: { commit: expect.stringMatching(/^[a-f0-9]{40}$/), sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(report.results[0].calls.map(call => call.actualModel)).toEqual(["first-split-returned", "first-extract-1", "first-extract-2"]);
    expect(report.results[0].extractModel).toBe("mixed: first-extract-1, first-extract-2");
    const first = report.results[0].calls[1].provenance;
    const second = report.results[1].calls[1].provenance;
    expect(first).toMatchObject({ datasetHash: report.provenance.datasetHash, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/), inputHash: expect.stringMatching(/^[a-f0-9]{64}$/), referenceHash: expect.stringMatching(/^[a-f0-9]{64}$/), promptHash: expect.stringMatching(/^[a-f0-9]{64}$/), schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/), requestedModel: "requested-extract", adapter: "fake-v1" });
    expect(second).toMatchObject({ datasetHash: first.datasetHash, sourceHash: first.sourceHash, inputHash: first.inputHash, referenceHash: first.referenceHash, promptHash: first.promptHash, schemaHash: first.schemaHash });
    expect(second.adapter).toBe("fake-v2");
  });

  it("continues after an unavailable Source File and failed Split with explicit missing coverage", async () => {
    const set: GoldenSet = { ...goldenSet, cases: [goldenSet.cases[0], { ...goldenSet.cases[0], id: "unavailable", sourcePath: "/private/missing.png" }] };
    const provider = scriptedProvider();
    provider.split = async () => { throw new Error("Split unavailable"); };
    const report = await evaluateGoldenSet(set, [{ provider }], async (file) => {
      if (file === "/private/missing.png") throw new Error("Source File unavailable");
      return new Uint8Array([1]);
    }, async bytes => bytes);
    expect(report.status).toBe("partial");
    expect(report.results[0].coverage).toEqual({
      split: { expected: 2, completed: 0, failed: 1, missing: 1 },
      extraction: { expected: 4, completed: 2, failed: 0, missing: 2 },
    });
    expect(report.results[0].criticalDocuments).toEqual({ correct: 1, total: 4, accuracy: 0.25, missing: 2 });
    expect(report.results[0].calls.filter(call => call.status === "missing")).toHaveLength(3);
    expect(report.results[0].calls[3]).toMatchObject({ status: "missing", actualModel: null, usage: null, costUsd: null, latencyMs: null,
      provenance: { sourceHash: null, inputHash: null } });
  });

  it("retains a returned model and raw diagnostic response even when a provider rejects its structured result", async () => {
    const provider = scriptedProvider();
    provider.split = async () => { throw withProviderResponse(new Error("invalid structured response"), '{"model":"split-returned-before-parse-failure","private":"diagnostic"}'); };
    const report = await evaluateGoldenSet(goldenSet, [{ provider }], async () => new Uint8Array([1]), async bytes => bytes);
    expect(report.results[0].calls[0]).toMatchObject({ status: "failed", actualModel: "split-returned-before-parse-failure", usage: null, costUsd: null,
      error: { message: "invalid structured response", rawResponse: '{"model":"split-returned-before-parse-failure","private":"diagnostic"}' } });
    expect(report.results[0].coverage).toMatchObject({ split: { failed: 1 }, extraction: { completed: 2 } });
  });

  it("keeps an unreported actual model unknown rather than substituting the requested model", async () => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const value = body.model === "requested-split" ? { documents: [{ firstPage: 1, lastPage: 1 }] } : expectedExtraction;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/v1/messages"
        ? { content: [{ type: "text", text: JSON.stringify(value) }] }
        : { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("stand-in did not bind");
      const configuration = { apiKey: "synthetic-test-key", splitModel: "requested-split", extractModel: "requested-extract", baseUrl: `http://127.0.0.1:${address.port}` };
      const reference: GoldenSet = { ...goldenSet, cases: [{ ...goldenSet.cases[0], pageCount: 1,
        expectedSplit: [{ firstPage: 1, lastPage: 1 }], documents: [goldenSet.cases[0].documents[0]] }] };
      const report = await evaluateGoldenSet(reference, [
        { provider: anthropicAiProvider(configuration) }, { provider: openAiProvider(configuration) },
      ], async () => new Uint8Array([137, 80, 78, 71]), async bytes => bytes);
      expect(report.status).toBe("complete");
      expect(report.results.map(result => result.calls.map(call => call.actualModel))).toEqual([[null, null], [null, null]]);
      expect(report.results.map(result => result.extractModel)).toEqual(["unavailable", "unavailable"]);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("fails a critical Document for one wrong cent despite correctly absent ancillary fields", async () => {
    const report = await evaluatePayload({ ...expectedExtraction, totals: { ...expectedExtraction.totals, grossAmount: "1210.01" } });

    expect(report.results[0].criticalDocuments).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(report.results[0].absence).toEqual({ correct: 11, total: 11, hallucinated: 0 });
    expect(report.results[0].documents[0]).toMatchObject({ criticalCorrect: false, requiresCorrection: true });
  });

  it("accepts only equivalent amount/date/identifier formats and rate order while preserving raw values", async () => {
    const expected = { ...expectedExtraction, rateBreakdown: [
      { rate: 12, netAmount: "100.00", vatAmount: "12.00" },
      { rate: 21, netAmount: "1000.00", vatAmount: "210.00" },
    ] };
    const actual = { ...expected, issueDate: "1.10.2026", supplier: { ...expected.supplier, vatId: "cz 27082440" },
      totals: { ...expected.totals, netAmount: "1 000,00" }, rateBreakdown: [...expected.rateBreakdown].reverse() };
    const report = await evaluatePayload(actual, expected);

    expect(report.results[0].criticalDocuments).toEqual({ correct: 1, total: 1, accuracy: 1 });
    expect(report.results[0].documents[0].raw.totals.netAmount).toBe("1 000,00");
    expect(report.results[0].documents[0].normalizations).toEqual(expect.arrayContaining([
      expect.objectContaining({ side: "actual", path: "totals.netAmount", before: "1 000,00", after: "1000.00" }),
      expect.objectContaining({ side: "actual", path: "rateBreakdown", reason: "rate_order" }),
    ]));
  });

  it("uses production Company Direction and scores VAT Regime separately in the correction decision", async () => {
    const report = await evaluatePayload({ ...expectedExtraction, direction: "outgoing", proposedVatRegime: "eu_acquisition_of_goods" });
    expect(report.results[0].direction).toEqual({ correct: 1, total: 1, accuracy: 1 });
    expect(report.results[0].vatRegime).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(report.results[0].criticalDocuments).toEqual({ correct: 1, total: 1, accuracy: 1 });
    expect(report.results[0].correctionFreeDocuments).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(report.results[0].documents[0]).toMatchObject({
      raw: { direction: "outgoing" },
      direction: { expected: "incoming", actual: "incoming", correct: true },
      vatRegime: { expected: "domestic", actual: "eu_acquisition_of_goods", correct: false },
      requiresCorrection: true,
    });
  });

  it("reports Split and literal field accuracy per provider and model", async () => {
    const report = await evaluateGoldenSet(
      goldenSet,
      [{ provider: scriptedProvider(), label: "scripted" }],
      async () => new Uint8Array([37, 80, 68, 70]),
      async (bytes) => bytes,
    );

    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      provider: "scripted",
      splitModel: "split-v1",
      extractModel: "extract-v2",
      split: { correct: 1, total: 1, accuracy: 1 },
    });
    expect(report.results[0].fields.documentNumber).toEqual({ correct: 1, total: 2, accuracy: 0.5 });
    expect(report.results[0].fields.currency).toEqual({ correct: 1, total: 2, accuracy: 0.5 });
    expect(report.results[0].fields["rateBreakdown.0.vatAmount"]).toEqual({ correct: 2, total: 2, accuracy: 1 });
    expect(report.results[0].fieldAccuracy).toEqual(expect.objectContaining({ total: expect.any(Number) }));
    expect(report.results[0].fieldAccuracy.correct).toBe(report.results[0].fieldAccuracy.total - 2);
  });

  it("formats a readable provider/model summary and per-field misses", async () => {
    const report = await evaluateGoldenSet(
      goldenSet,
      [{ provider: scriptedProvider(), label: "scripted" }],
      async () => new Uint8Array([37, 80, 68, 70]),
      async (bytes) => bytes,
    );

    expect(formatEvaluationReport(report)).toContain("Provider 1 | Split models: 1 | Extract models: 1");
    expect(formatEvaluationReport(report)).toContain("Split accuracy: 1/1 (100.00%)");
    expect(formatEvaluationReport(report)).toContain("Isolated Extraction on human reference ranges; not end-to-end production accuracy");
    expect(formatEvaluationReport(report)).toContain("Critical financial Documents: 1/2 (50.00%)");
    expect(formatEvaluationReport(report)).toContain("Correction-free Documents (including ancillary fields): 1/2 (50.00%)");
    expect(formatEvaluationReport(report)).toContain("Known absence: 22/22; hallucinated values: 0");
    expect(formatEvaluationReport(report)).toContain("documentNumber: 1/2 (50.00%)");
  });

  it("scores an unexpected Rate Breakdown line as a hallucinated absence", async () => {
    const blankRates = { ...expectedExtraction, rateBreakdown: [] };
    const oneCase: GoldenSet = {
      schemaVersion: 1,
      cases: [{
        id: "blank-rates",
        sourcePath: "/golden/blank.png",
        format: "png",
        mediaType: "image/png",
        pageCount: 1,
        company: { ico: "12345678", vatId: "CZ12345678" },
        expectedSplit: [{ firstPage: 1, lastPage: 1 }],
        documents: [{ pages: { firstPage: 1, lastPage: 1 }, expected: blankRates }],
      }],
    };
    const provider: AiProvider = {
      name: "scripted",
      region: "local",
      async split() {
        return { model: "split", documents: [{ firstPage: 1, lastPage: 1 }] };
      },
      async extract() {
        return { model: "extract", payload: expectedExtraction };
      },
    };

    const report = await evaluateGoldenSet(
      oneCase,
      [{ provider }],
      async () => new Uint8Array([137, 80, 78, 71]),
      async (bytes) => bytes,
    );

    expect(report.results[0].absentFields["rateBreakdown.length"]).toEqual({ correct: 0, total: 1, hallucinated: 1 });
  });

  it("loads expected values stored beside a relative golden-set manifest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ivat-golden-set-"));
    await writeFile(path.join(directory, "invoice.pdf"), "%PDF-test");
    await writeFile(path.join(directory, "invoice.expected.json"), JSON.stringify(expectedExtraction));
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      cases: [{
        id: "invoice",
        source: "invoice.pdf",
        format: "pdf",
        pageCount: 1,
        company: { ico: "12345678", vatId: "CZ12345678" },
        expectedSplit: [{ firstPage: 1, lastPage: 1 }],
        documents: [{ pages: { firstPage: 1, lastPage: 1 }, expected: "invoice.expected.json" }],
      }],
    }));

    await expect(loadGoldenSet(manifestPath)).resolves.toMatchObject({
      schemaVersion: 1,
      cases: [{
        id: "invoice",
        sourcePath: path.join(directory, "invoice.pdf"),
        format: "pdf",
        mediaType: "application/pdf",
        pageCount: 1,
        company: { ico: "12345678", vatId: "CZ12345678" },
        expectedSplit: [{ firstPage: 1, lastPage: 1 }],
        documents: [{ pages: { firstPage: 1, lastPage: 1 }, expected: expectedExtraction }],
      }],
    });
  });

  it("refuses an expected payload that omits a scored field", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ivat-incomplete-golden-set-"));
    const incomplete: Partial<ExtractionPayload> = { ...expectedExtraction };
    delete incomplete.reverseChargeCode;
    await writeFile(path.join(directory, "invoice.pdf"), "%PDF-test");
    await writeFile(path.join(directory, "invoice.expected.json"), JSON.stringify(incomplete));
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      cases: [{
        id: "invoice",
        source: "invoice.pdf",
        format: "pdf",
        pageCount: 1,
        company: { ico: "12345678", vatId: "CZ12345678" },
        expectedSplit: [{ firstPage: 1, lastPage: 1 }],
        documents: [{ pages: { firstPage: 1, lastPage: 1 }, expected: "invoice.expected.json" }],
      }],
    }));

    await expect(loadGoldenSet(manifestPath)).rejects.toThrow("complete Extraction payload");
  });

  it("refuses incomplete in-memory references before any external provider work", async () => {
    const incomplete = { ...expectedExtraction } as Partial<ExtractionPayload>;
    delete incomplete.reverseChargeCode;
    const provider = scriptedProvider();
    provider.split = async () => { throw new Error("Unexpected provider call"); };
    const source = goldenSet.cases[0];
    await expect(evaluateGoldenSet({ ...goldenSet, cases: [{ ...source, documents: [
      source.documents[0], { ...source.documents[1], expected: incomplete as ExtractionPayload },
    ] }] }, [{ provider }], async () => { throw new Error("Unexpected Source File read"); }, async (bytes) => bytes))
      .rejects.toThrow("complete Extraction payload");
  });

  it("refuses ambiguous duplicate reference rates instead of accepting a matching duplicate output", async () => {
    const duplicated = { ...expectedExtraction, rateBreakdown: [expectedExtraction.rateBreakdown[0], expectedExtraction.rateBreakdown[0]] };
    await expect(evaluatePayload(duplicated, duplicated)).rejects.toThrow("duplicate Rate Breakdown");
  });

  it("keeps unreadable references distinct from known absence and refuses them before AI calls", async () => {
    const source = goldenSet.cases[0];
    const reference: GoldenSet = { ...goldenSet, cases: [{ ...source, documents: [
      { ...source.documents[0], unresolvedFields: ["supplier.vatId"] }, source.documents[1],
    ] }] };
    await expect(evaluateGoldenSet(reference, [{ provider: scriptedProvider() }], async () => new Uint8Array([1]), async (bytes) => bytes))
      .rejects.toThrow("unresolved reference");
  });

  it("keeps a critical pass distinct from an ancillary correction and hallucinated absence", async () => {
    const report = await evaluatePayload({ ...expectedExtraction, dueDate: "2026-10-31" });
    expect(report.results[0].absence).toEqual({ correct: 10, total: 11, hallucinated: 1 });
    expect(report.results[0].fields.dueDate).toBeUndefined();
    expect(report.results[0].criticalDocuments).toEqual({ correct: 1, total: 1, accuracy: 1 });
    expect(report.results[0].documents[0]).toMatchObject({ criticalCorrect: true, requiresCorrection: true });
    expect(report.results[0].documents[0].differences).toContainEqual({ path: "dueDate", expected: null, actual: "2026-10-31", kind: "hallucinated" });
  });

  it("refuses wrongly typed reference facts rather than awarding matching invalid values", async () => {
    const invalid = { ...expectedExtraction, supplier: { ...expectedExtraction.supplier, name: 123 } } as unknown as ExtractionPayload;
    await expect(evaluatePayload(invalid, invalid)).rejects.toThrow("reference fact");
  });

  it.each([
    ["wrong sign", { ...expectedExtraction, totals: { ...expectedExtraction.totals, netAmount: "-1000.00" } }],
    ["extra precision", { ...expectedExtraction, totals: { ...expectedExtraction.totals, vatAmount: "210.001" } }],
    ["missing rate", { ...expectedExtraction, rateBreakdown: [] }],
    ["extra rate", { ...expectedExtraction, rateBreakdown: [...expectedExtraction.rateBreakdown, { rate: 12, netAmount: "100.00", vatAmount: "12.00" }] }],
    ["ambiguous duplicate output rate", { ...expectedExtraction, rateBreakdown: [expectedExtraction.rateBreakdown[0], expectedExtraction.rateBreakdown[0]] }],
    ["wrong party side", { ...expectedExtraction, supplier: expectedExtraction.customer, customer: expectedExtraction.supplier }],
    ["hallucinated identifier", { ...expectedExtraction, customer: { ...expectedExtraction.customer, ico: "12345678" } }],
  ])("fails critical correctness for %s without tolerance or repair", async (_name, actual) => {
    const report = await evaluatePayload(actual);
    expect(report.results[0].criticalDocuments).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(report.results[0].documents[0].requiresCorrection).toBe(true);
  });

  it("scores a Credit Note's signed original-currency amounts and printed original Document number", async () => {
    const expected: ExtractionPayload = { ...expectedExtraction, documentType: "credit_note", currency: "EUR", originalDocumentNumber: "FV-ORIGINAL",
      rateBreakdown: [{ rate: 21, netAmount: "-1000.00", vatAmount: "-210.00" }],
      totals: { netAmount: "-1000.00", vatAmount: "-210.00", grossAmount: "-1210.00" } };
    const report = await evaluatePayload({ ...expected, originalDocumentNumber: "FV-DIFFERENT" }, expected);
    expect(report.results[0].fields["totals.grossAmount"]).toEqual({ correct: 1, total: 1, accuracy: 1 });
    expect(report.results[0].fields.originalDocumentNumber).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(report.results[0].criticalDocuments).toEqual({ correct: 0, total: 1, accuracy: 0 });
  });

  it("keeps wrong whole-Source Split separate from correct Extraction of both reference ranges", async () => {
    const provider = scriptedProvider();
    provider.split = async () => ({ model: "wrong-split", documents: [{ firstPage: 1, lastPage: 2 }] });
    provider.extract = async (input) => ({ model: "extract", payload: { ...expectedExtraction, documentNumber: input.bytes[0] === 1 ? "FV-100" : "FV-200" } });
    const report = await evaluateGoldenSet(goldenSet, [{ provider }], async () => new Uint8Array([99]),
      async (_bytes, _source, pages) => new Uint8Array([pages.firstPage]));
    expect(report).toMatchObject({ extractionScope: "isolated_reference_ranges", documents: 2 });
    expect(report.results[0].split).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(report.results[0].splitDetails[0]).toEqual({ caseId: "two-documents", correct: false,
      expected: [{ firstPage: 1, lastPage: 1 }, { firstPage: 2, lastPage: 2 }], actual: [{ firstPage: 1, lastPage: 2 }] });
    expect(report.results[0].criticalDocuments).toEqual({ correct: 2, total: 2, accuracy: 1 });
  });

  it("does not score confidence, geometry, derived CZK or human claim metadata as financial facts", async () => {
    const report = await evaluatePayload({ ...expectedExtraction, confidence: { documentNumber: 0.01 }, sourceLocations: [],
      czkConversion: { originalCurrency: "EUR", rate: "25.000", unit: 1, rateDate: "2026-10-01", source: "CNB", rateBreakdown: [], totals: { netAmount: "999999.00", vatAmount: "0.00", grossAmount: "999999.00" } } });
    expect(report.results[0].correctionFreeDocuments).toEqual({ correct: 1, total: 1, accuracy: 1 });
    expect(report.results[0].fieldAccuracy).toEqual({ correct: 23, total: 23, accuracy: 1 });
  });

  it("keeps an indeterminate production Direction separate from a provider's incoming guess", async () => {
    const expected = { ...expectedExtraction, customer: { ...expectedExtraction.customer, vatId: null } };
    const report = await evaluatePayload(expected, expected);
    expect(report.results[0].criticalDocuments).toEqual({ correct: 1, total: 1, accuracy: 1 });
    expect(report.results[0].direction).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(report.results[0].documents[0]).toMatchObject({ raw: { direction: "incoming" }, direction: { actual: null, correct: false }, requiresCorrection: true });
  });

  it("retains completed results and failed coverage in every denominator without inventing usage", async () => {
    const provider = scriptedProvider();
    let calls = 0;
    provider.extract = async () => {
      if (++calls === 2) throw new Error("private synthetic provider failure");
      return { model: "extract-completed", payload: expectedExtraction, usage: { inputTokens: 7, outputTokens: 3 } };
    };
    const report = await evaluateGoldenSet(goldenSet, [{ provider }], async () => new Uint8Array([1]), async (bytes) => bytes);
    expect(report.status).toBe("partial");
    expect(report.results[0].coverage).toEqual({
      split: { expected: 1, completed: 1, failed: 0, missing: 0 },
      extraction: { expected: 2, completed: 1, failed: 1, missing: 0 },
    });
    expect(report.results[0].criticalDocuments).toEqual({ correct: 1, total: 2, accuracy: 0.5, missing: 1 });
    expect(report.results[0].fields.documentNumber).toEqual({ correct: 1, total: 2, accuracy: 0.5, missing: 1 });
    expect(report.results[0].documents).toHaveLength(1);
    expect(report.results[0].calls).toHaveLength(3);
    expect(report.results[0].calls[1]).toMatchObject({ status: "completed", actualModel: "extract-completed", usage: { inputTokens: 7, outputTokens: 3 }, costUsd: null });
    expect(report.results[0].calls[2]).toMatchObject({ status: "failed", actualModel: null, usage: null, costUsd: null, error: { message: "private synthetic provider failure" } });
  });

  it("applies the same explicit format equivalence to human references without rewriting their raw facts", async () => {
    const reference = { ...expectedExtraction, issueDate: "1.10.2026", totals: { ...expectedExtraction.totals, netAmount: "1 000,00" } };
    const report = await evaluatePayload(expectedExtraction, reference);
    expect(report.results[0].criticalDocuments).toEqual({ correct: 1, total: 1, accuracy: 1 });
    expect(reference.totals.netAmount).toBe("1 000,00");
    expect(report.results[0].documents[0].normalizations).toContainEqual({ side: "expected", path: "totals.netAmount", before: "1 000,00", after: "1000.00", reason: "equivalent_format" });
  });

  it("does not report present financial accuracy from an entirely blank reference", async () => {
    const blank = emptyDocumentPayload();
    const report = await evaluatePayload(blank, blank);
    expect(report.results[0].fieldAccuracy).toEqual({ correct: 0, total: 0, accuracy: 0 });
    expect(report.results[0].criticalAccuracy).toEqual({ correct: 0, total: 0, accuracy: 0 });
    expect(report.results[0].direction).toEqual({ correct: 0, total: 0, accuracy: 0 });
    expect(report.results[0].vatRegime).toEqual({ correct: 0, total: 0, accuracy: 0 });
    expect(report.results[0].absence).toEqual({ correct: 31, total: 31, hallucinated: 0 });
  });
});
