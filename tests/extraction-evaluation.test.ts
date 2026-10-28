import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AiProvider } from "@/application/ai-provider";
import type { ExtractionPayload } from "@/application/extraction-payload";
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
    sourcePath: "/golden/two-documents.pdf",
    format: "pdf",
    mediaType: "application/pdf",
    pageCount: 2,
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

describe("Extraction evaluation", () => {
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

    expect(formatEvaluationReport(report)).toContain("scripted | Split split-v1 | Extract extract-v2");
    expect(formatEvaluationReport(report)).toContain("Split accuracy: 1/1 (100.00%)");
    expect(formatEvaluationReport(report)).toContain("documentNumber: 1/2 (50.00%)");
  });

  it("scores an unexpected Rate Breakdown line as a field miss", async () => {
    const blankRates = { ...expectedExtraction, rateBreakdown: [] };
    const oneCase: GoldenSet = {
      schemaVersion: 1,
      cases: [{
        id: "blank-rates",
        sourcePath: "/golden/blank.png",
        format: "png",
        mediaType: "image/png",
        pageCount: 1,
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

    expect(report.results[0].fields["rateBreakdown.length"]).toEqual({ correct: 0, total: 1, accuracy: 0 });
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
        expectedSplit: [{ firstPage: 1, lastPage: 1 }],
        documents: [{ pages: { firstPage: 1, lastPage: 1 }, expected: "invoice.expected.json" }],
      }],
    }));

    await expect(loadGoldenSet(manifestPath)).resolves.toEqual({
      schemaVersion: 1,
      cases: [{
        id: "invoice",
        sourcePath: path.join(directory, "invoice.pdf"),
        format: "pdf",
        mediaType: "application/pdf",
        pageCount: 1,
        expectedSplit: [{ firstPage: 1, lastPage: 1 }],
        documents: [{ pages: { firstPage: 1, lastPage: 1 }, expected: expectedExtraction }],
      }],
    });
  });

  it("refuses an expected payload that omits a scored field", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ivat-incomplete-golden-set-"));
    const incomplete: Partial<ExtractionPayload> = { ...expectedExtraction };
    delete incomplete.documentNumber;
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
        expectedSplit: [{ firstPage: 1, lastPage: 1 }],
        documents: [{ pages: { firstPage: 1, lastPage: 1 }, expected: "invoice.expected.json" }],
      }],
    }));

    await expect(loadGoldenSet(manifestPath)).rejects.toThrow("complete Extraction payload");
  });
});
