import { sourceEvidencePdfFixture } from "../support/source-evidence";
import { expect, it } from "vitest";
import { openAiProvider } from "@/ai/openai";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runEvaluationCli } from "@/evaluation/evaluation-cli";
import { emptyDocumentPayload } from "@/application/extraction-payload";

const simulation = process.env.OPENAI_SIMULATION_BASE_URL ? it : it.skip;

simulation("runs the bounded public evaluator CLI against real HTTP simulation requests and private reports", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ivat-bounded-simulation-"));
  await writeFile(path.join(directory, "source.pdf"), await sourceEvidencePdfFixture());
  await writeFile(path.join(directory, "expected.json"), JSON.stringify(emptyDocumentPayload()));
  const manifest = path.join(directory, "manifest.json");
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, cases: [{ id: "synthetic-bounded", source: "source.pdf", format: "pdf", pageCount: 3,
    company: { ico: "12345678", vatId: "CZ12345678" }, expectedSplit: [{ firstPage: 1, lastPage: 3 }],
    documents: [{ pages: { firstPage: 1, lastPage: 3 }, expected: "expected.json" }] }] }));
  const reportPath = path.join(directory, "report.json");
  const result = await runEvaluationCli({ argv: [manifest, "--json"], env: { EVALUATION_REPORT_PATH: reportPath,
    EVALUATION_MAX_CALLS: "2", EVALUATION_MAX_GENERATED_TOKENS: "1024", EVALUATION_GENERATED_TOKENS_PER_ATTEMPT: "512", EVALUATION_MAX_RETRIES: "0" },
    providers: [{ provider: openAiProvider({ apiKey: "simulation-secret", splitModel: "bounded-evaluator", extractModel: "bounded-evaluator", baseUrl: process.env.OPENAI_SIMULATION_BASE_URL }) }] });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ mode: "run", providerCalls: 2, status: "complete", budget: {
    attemptedCalls: 2, reservedGeneratedTokens: 1024, observedInputTokens: 64, observedGeneratedTokens: 24, stopReason: null },
    costs: { providerReportedUsd: null, estimatedUsd: null, hardMonetaryCap: false } });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  expect(report.results[0].calls).toMatchObject([{ actualModel: "bounded-evaluator", status: "completed" }, { actualModel: "bounded-evaluator", status: "completed" }]);
});

simulation("runs native Split and rasterized PDF Extraction through the OpenAI HTTP simulation", async () => {
  const provider = openAiProvider({
    apiKey: "simulation-secret",
    splitModel: "gpt-split",
    extractModel: "gpt-extract",
    baseUrl: process.env.OPENAI_SIMULATION_BASE_URL,
  });

  await expect(provider.split({
    format: "pdf",
    mediaType: "application/pdf",
    bytes: new Uint8Array([37, 80, 68, 70]),
    pageCount: 1,
  })).resolves.toEqual({ model: "gpt-split", documents: [{ firstPage: 1, lastPage: 1 }] });
  await expect(provider.extract({
    format: "pdf",
    mediaType: "application/pdf",
    bytes: await sourceEvidencePdfFixture(),
    pageCount: 3,
  })).resolves.toEqual(expect.objectContaining({
    model: "gpt-extract",
    payload: expect.objectContaining({ schemaVersion: 1, documentNumber: "SIM-1" }),
  }));
});
