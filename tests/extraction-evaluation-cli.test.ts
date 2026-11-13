import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { emptyDocumentPayload } from "@/application/extraction-payload";
import { AiProviderError, withProviderResponse, type AiProvider } from "@/application/ai-provider";
import { runEvaluationCli } from "@/evaluation/evaluation-cli";

const limits = { EVALUATION_MAX_CALLS: "100", EVALUATION_MAX_GENERATED_TOKENS: "10000",
  EVALUATION_GENERATED_TOKENS_PER_ATTEMPT: "100", EVALUATION_MAX_RETRIES: "0" };

async function privateFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ivat-private-evaluation-"));
  const expected = { ...emptyDocumentPayload(), documentNumber: "PRIVATE-INVOICE-989", totals: { netAmount: "76543.21", vatAmount: null, grossAmount: null } };
  await writeFile(path.join(directory, "private-source.png"), await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer());
  await writeFile(path.join(directory, "private-reference.json"), JSON.stringify(expected));
  const manifest = path.join(directory, "private-manifest.json");
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, cases: [{ id: "PRIVATE-BUSINESS-ID", source: "private-source.png", format: "png", pageCount: 1,
    company: { ico: "12345678", vatId: "CZ12345678" }, expectedSplit: [{ firstPage: 1, lastPage: 1 }],
    documents: [{ pages: { firstPage: 1, lastPage: 1 }, expected: "private-reference.json" }] }] }));
  const provider: AiProvider = { name: "PRIVATE-PROVIDER-LABEL", region: "local",
    async split() { return { model: "PRIVATE-MODEL-NAME", documents: [{ firstPage: 1, lastPage: 1 }], usage: { inputTokens: 2, outputTokens: 3 } }; },
    async extract() { throw new Error("PRIVATE-FAILURE-DATA"); },
  };
  return { directory, manifest, provider };
}

describe("Extraction evaluation CLI", () => {
  it("records different effective provider configurations when the generated request ceiling changes", async () => {
    const fixture = await privateFixture();
    const configurations: string[] = [];
    for (const ceiling of [100, 200]) {
      const reportPath = path.join(fixture.directory, `ceiling-${ceiling}.json`);
      await runEvaluationCli({ argv: [fixture.manifest], env: { ...limits, EVALUATION_GENERATED_TOKENS_PER_ATTEMPT: String(ceiling),
        EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      configurations.push(report.results[0].calls[0].provenance.configurationHash);
    }
    expect(configurations[0]).not.toBe(configurations[1]);
  });
  it("runs the installed CLI entry point as a zero-call process without provider credentials", async () => {
    const fixture = await privateFixture();
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/evaluate-extraction.ts", fixture.manifest, "--preflight", "--json"], {
      cwd: process.cwd(), env: { ...process.env, ...limits, EVALUATION_PROVIDERS: "openai", OPENAI_CONTRACT_MODEL: "selected-synthetic",
        OPENAI_CONTRACT_API_KEY: "", ANTHROPIC_CONTRACT_API_KEY: "", EVALUATION_REPORT_PATH: path.join(fixture.directory, "process-preflight.json") },
    });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "preflight", providerCalls: 0, cases: 1, documents: 1 });
  });

  it("retains a failed attempt and earlier success when the next retry cannot be admitted", async () => {
    const fixture = await privateFixture();
    let extractionCalls = 0;
    fixture.provider.extract = async () => {
      extractionCalls++;
      throw withProviderResponse(new AiProviderError("failure", "synthetic metered failure", { transient: true }),
        JSON.stringify({ model: "failed-extract", usage: { input_tokens: 6, output_tokens: 7 } }));
    };
    const reportPath = path.join(fixture.directory, "retry-exhausted.json");
    const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { ...limits, EVALUATION_MAX_CALLS: "2", EVALUATION_MAX_RETRIES: "1",
      EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
    expect(result.exitCode).toBe(2);
    expect(extractionCalls).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ providerCalls: 2, budget: { stopReason: "call_limit", reservedGeneratedTokens: 200,
      observedInputTokens: 8, observedGeneratedTokens: 10, observedTotalTokens: 18 },
      results: [{ coverage: { split: { completed: 1 }, extraction: { failed: 1, missing: 0 } } }] });
    const raw = JSON.parse(await readFile(reportPath, "utf8"));
    expect(raw.results[0].calls[1]).toMatchObject({ status: "failed", actualModel: "failed-extract", attempts: [{ status: "failed", error: { message: "synthetic metered failure" } }] });
  });

  it("refuses unverified or malformed tariffs before dispatch and leaves unknown model estimates unavailable", async () => {
    const fixture = await privateFixture();
    let dispatched = 0;
    const tariff = { provider: fixture.provider.name, model: "configured-only", inputUsdPerMillion: "2", outputUsdPerMillion: "10", source: "https://example.test/price", verifiedAt: "2026-11-01", verified: true };
    const pricePath = path.join(fixture.directory, "tariff.json");
    fixture.provider.split = async () => { dispatched++; return { model: "configured-only", modelReported: false,
      documents: [{ firstPage: 1, lastPage: 1 }], usage: { inputTokens: 2, outputTokens: 3 } }; };
    for (const [index, value] of [[{ ...tariff, verified: false }], [{ ...tariff, verifiedAt: "2026-02-30" }],
      [{ ...tariff, outputUsdPerMillion: "-1" }], [tariff, tariff]].entries()) {
      await writeFile(pricePath, JSON.stringify(value));
      const result = await runEvaluationCli({ argv: [fixture.manifest], env: { ...limits, EVALUATION_PRICE_TABLE_PATH: pricePath,
        EVALUATION_REPORT_PATH: path.join(fixture.directory, `tariff-refused-${index}.json`) }, providers: [{ provider: fixture.provider }] });
      expect(result.exitCode).toBe(1);
    }
    expect(dispatched).toBe(0);
    await writeFile(pricePath, JSON.stringify([tariff]));
    fixture.provider.extract = async () => ({ model: "returned-different", payload: emptyDocumentPayload(), usage: { inputTokens: 4, outputTokens: 5 } });
    const reportPath = path.join(fixture.directory, "unknown-price.json");
    const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { ...limits, EVALUATION_PRICE_TABLE_PATH: pricePath,
      EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ costs: { providerReportedUsd: null, estimatedUsd: null, estimatedAttempts: 0 } });
    const raw = JSON.parse(await readFile(reportPath, "utf8"));
    expect(raw.results[0].calls).toMatchObject([{ actualModel: null, costUsd: null, estimatedPrice: null }, { actualModel: "returned-different", estimatedPrice: null }]);
  });
  it("refuses absent, malformed, ambiguous total-token and monetary hard limits before provider dispatch", async () => {
    const fixture = await privateFixture();
    let dispatched = 0;
    fixture.provider.split = async () => { dispatched++; throw new Error("must not dispatch"); };
    const invalid = [
      { EVALUATION_MAX_CALLS: undefined }, { EVALUATION_MAX_CALLS: "1.5" }, { EVALUATION_MAX_CALLS: "9007199254740992" },
      { EVALUATION_MAX_GENERATED_TOKENS: "0" }, { EVALUATION_GENERATED_TOKENS_PER_ATTEMPT: "15" },
      { EVALUATION_MAX_RETRIES: "-1" }, { EVALUATION_REPETITIONS: "0" }, { EVALUATION_MAX_TOTAL_TOKENS: "500" },
      { EVALUATION_MAX_TOKENS: "500" }, { EVALUATION_MAX_COST_USD: "1" },
    ];
    for (const [index, patch] of invalid.entries()) {
      const reportPath = path.join(fixture.directory, `invalid-${index}.json`);
      const result = await runEvaluationCli({ argv: [fixture.manifest], env: { ...limits, ...patch, EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      await expect(stat(reportPath)).rejects.toThrow();
    }
    expect(dispatched).toBe(0);
  });

  it("stops on invalid metering and never reports its unavailable usage as zero", async () => {
    const fixture = await privateFixture();
    for (const [index, usage] of [{ inputTokens: -1, outputTokens: 0 }, { inputTokens: 2, outputTokens: 101 },
      { inputTokens: 2, outputTokens: 0.5 }, { inputTokens: Number.NaN, outputTokens: 0 }].entries()) {
      fixture.provider.split = async () => ({ model: "invalid-meter", documents: [{ firstPage: 1, lastPage: 1 }], usage });
      const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { ...limits,
        EVALUATION_REPORT_PATH: path.join(fixture.directory, `invalid-usage-${index}.json`) }, providers: [{ provider: fixture.provider }] });
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ providerCalls: 1, budget: { stopReason: "usage_invalid", meteredAttempts: 0,
        unmeteredAttempts: 1, observedInputTokens: null, observedGeneratedTokens: null, reservedGeneratedTokens: 100 } });
    }
  });

  it("does not retry a permanent refusal or exceed the retry ceiling for a metered transient failure", async () => {
    const fixture = await privateFixture();
    for (const transient of [false, true]) {
      let splitCalls = 0;
      fixture.provider.split = async () => {
        splitCalls++;
        throw withProviderResponse(new AiProviderError("failure", "failure", { transient }), JSON.stringify({ usage: { input_tokens: 2, output_tokens: 0 } }));
      };
      fixture.provider.extract = async () => ({ model: "extract", payload: emptyDocumentPayload(), usage: { inputTokens: 3, outputTokens: 4 } });
      const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { ...limits, EVALUATION_MAX_RETRIES: "1",
        EVALUATION_REPORT_PATH: path.join(fixture.directory, `refusal-${transient}.json`) }, providers: [{ provider: fixture.provider }] });
      expect(result.exitCode).toBe(2);
      expect(splitCalls).toBe(transient ? 2 : 1);
      expect(JSON.parse(result.stdout)).toMatchObject({ results: [{ coverage: { split: { expected: 1, failed: 1 }, extraction: { completed: 1 } } }] });
    }
  });
  it("estimates only the generated component of a preflight from fully attributed supplied tariffs", async () => {
    const fixture = await privateFixture();
    const prices = path.join(fixture.directory, "tariffs.json");
    await writeFile(prices, JSON.stringify([{ provider: fixture.provider.name, model: "planned", inputUsdPerMillion: "2", outputUsdPerMillion: "10",
      source: "https://example.test/verified", verifiedAt: "2026-11-01", verified: true }]));
    const result = await runEvaluationCli({ argv: [fixture.manifest, "--preflight", "--json"], env: { ...limits,
      EVALUATION_PRICE_TABLE_PATH: prices, EVALUATION_REPORT_PATH: path.join(fixture.directory, "priced-plan.json") },
      providers: [{ provider: fixture.provider, identity: { adapter: "synthetic", configuration: { splitModel: "planned", extractModel: "planned" } } }] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ providerCalls: 0, plan: { estimatedPriceUsd: null,
      generatedPriceEstimate: { usd: "0.002000000000", scope: "generated_tokens_only" }, inputTokens: null, totalTokens: null, hardMonetaryCap: false } });
  });
  it("prints the concrete human preflight with token units and no measured accuracy claim", async () => {
    const fixture = await privateFixture();
    let providerCalls = 0;
    fixture.provider.split = async () => { providerCalls++; throw new Error("preflight must not call Split"); };
    fixture.provider.extract = async () => { providerCalls++; throw new Error("preflight must not call Extraction"); };
    const result = await runEvaluationCli({ argv: [fixture.manifest, "--preflight"], env: { ...limits,
      EVALUATION_REPORT_PATH: path.join(fixture.directory, "human-plan.json") }, providers: [{ provider: fixture.provider }] });
    expect(result.exitCode).toBe(0);
    expect(providerCalls).toBe(0);
    expect(result.stdout).toContain("Preflight: 0 provider calls");
    expect(result.stdout).toContain("2 measurements; at most 2 attempts");
    expect(result.stdout).toContain("Generated/output tokens: 100 per attempt; 10000 globally");
    expect(result.stdout).toContain("Input/total token ceiling: unavailable");
    expect(result.stdout).toContain("No guaranteed monetary cap");
    expect(result.stdout).not.toContain("accuracy:");
  });
  it("attributes supplied tariff estimates separately from observed tokens and provider-reported costs", async () => {
    const fixture = await privateFixture();
    fixture.provider.split = async () => ({ model: "priced", documents: [{ firstPage: 1, lastPage: 1 }], usage: { inputTokens: 1000, outputTokens: 20, costUsd: 0.03 } });
    fixture.provider.extract = async () => ({ model: "priced", payload: emptyDocumentPayload(), usage: { inputTokens: 2000, outputTokens: 30 } });
    const prices = path.join(fixture.directory, "tariffs.json");
    await writeFile(prices, JSON.stringify([{ provider: fixture.provider.name, model: "priced", inputUsdPerMillion: "2.00", outputUsdPerMillion: "10.00",
      source: "https://example.test/verified-tariff", verifiedAt: "2026-11-01", verified: true }]));
    const reportPath = path.join(fixture.directory, "priced.json");
    const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { ...limits,
      EVALUATION_PRICE_TABLE_PATH: prices, EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.results[0].calls[0]).toMatchObject({ costUsd: 0.03, estimatedPrice: { usd: "0.002200000000", basis: { model: "priced", verifiedAt: "2026-11-01" } } });
    expect(report.results[0].calls[1]).toMatchObject({ costUsd: null, estimatedPrice: { usd: "0.004300000000" } });
    expect(JSON.parse(result.stdout)).toMatchObject({ costs: { providerReportedUsd: null, providerReportedSubtotalUsd: 0.03,
      estimatedUsd: "0.006500000000", estimatedAttempts: 2, providerReportedAttempts: 1, hardMonetaryCap: false } });
    expect(result.stdout).not.toContain("example.test");
  });
  it("accounts for metered transient retries without adding measurements or evading the global reservation", async () => {
    const fixture = await privateFixture();
    let splitAttempts = 0;
    fixture.provider.split = async () => {
      if (++splitAttempts === 1) throw withProviderResponse(new AiProviderError("transient", "retry", { transient: true }),
        JSON.stringify({ model: "failed-model", usage: { input_tokens: 7, output_tokens: 0 } }));
      return { model: "success-model", documents: [{ firstPage: 1, lastPage: 1 }], usage: { inputTokens: 8, outputTokens: 9 } };
    };
    fixture.provider.extract = async () => ({ model: "extract", payload: emptyDocumentPayload(), usage: { inputTokens: 10, outputTokens: 11 } });
    const reportPath = path.join(fixture.directory, "retry.json");
    const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { ...limits, EVALUATION_MAX_RETRIES: "1",
      EVALUATION_MAX_CALLS: "3", EVALUATION_MAX_GENERATED_TOKENS: "300", EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
    expect(result.exitCode).toBe(0);
    expect(splitAttempts).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ providerCalls: 3, budget: { attemptedCalls: 3, reservedGeneratedTokens: 300,
      observedInputTokens: 25, observedGeneratedTokens: 20, meteredAttempts: 3, stopReason: null },
      results: [{ coverage: { split: { expected: 1, completed: 1, failed: 0 }, extraction: { expected: 1, completed: 1 } } }],
    });
    const raw = JSON.parse(await readFile(reportPath, "utf8"));
    expect(raw.results[0].calls[0].attempts).toMatchObject([{ status: "failed", actualModel: "failed-model" }, { status: "completed", actualModel: "success-model" }]);
  });
  it("reserves generated tokens before dispatch and never refunds them across providers or repetitions", async () => {
    const fixture = await privateFixture();
    let calls = 0;
    fixture.provider.split = async (_input, _context, cap) => {
      expect(cap).toEqual({ maxOutputTokens: 100 }); calls++;
      return { model: "first", documents: [{ firstPage: 1, lastPage: 1 }], usage: { inputTokens: 0, outputTokens: 0 } };
    };
    const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { ...limits,
      EVALUATION_REPETITIONS: "2", EVALUATION_MAX_GENERATED_TOKENS: "199", EVALUATION_REPORT_PATH: path.join(fixture.directory, "generated.json") },
      providers: [{ provider: fixture.provider }, { provider: fixture.provider }] });
    expect(calls).toBe(1);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ providerCalls: 1, plan: { measurements: 8, repetitions: 2 },
      budget: { attemptedCalls: 1, reservedGeneratedTokens: 100, observedInputTokens: 0, observedGeneratedTokens: 0, stopReason: "generated_token_limit" } });
    expect(JSON.parse(result.stdout).results).toHaveLength(4);
  });
  it("stops after unavailable usage without treating it as zero or refunding the attempt reservation", async () => {
    const fixture = await privateFixture();
    fixture.provider.split = async () => ({ model: "unmetered", documents: [{ firstPage: 1, lastPage: 1 }] });
    const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { ...limits,
      EVALUATION_REPORT_PATH: path.join(fixture.directory, "unknown-usage.json") }, providers: [{ provider: fixture.provider }] });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ providerCalls: 1, budget: { attemptedCalls: 1, reservedGeneratedTokens: 100,
      observedInputTokens: null, observedGeneratedTokens: null, meteredAttempts: 0, unmeteredAttempts: 1, stopReason: "usage_unavailable" },
      results: [{ coverage: { split: { completed: 1 }, extraction: { missing: 1 } } }],
    });
  });
  it("preserves the measured Split and unmeasured Extraction when the global call allowance is exhausted", async () => {
    const fixture = await privateFixture();
    let attempts = 0;
    const split = fixture.provider.split;
    fixture.provider.split = async input => { attempts++; return split(input); };
    fixture.provider.extract = async () => { attempts++; throw new Error("must not dispatch"); };
    const reportPath = path.join(fixture.directory, "limited.json");
    const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { ...limits,
      EVALUATION_MAX_CALLS: "1", EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
    expect(result.exitCode).toBe(2);
    expect(attempts).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ providerCalls: 1, status: "partial",
      budget: { attemptedCalls: 1, reservedGeneratedTokens: 100, stopReason: "call_limit", observedInputTokens: 2, observedGeneratedTokens: 3 },
      results: [{ coverage: { split: { completed: 1 }, extraction: { expected: 1, completed: 0, missing: 1 } }, criticalDocuments: { total: 1, missing: 1 } }],
    });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.results[0].calls[0]).toMatchObject({ status: "completed", actualModel: "PRIVATE-MODEL-NAME", usage: { inputTokens: 2, outputTokens: 3 } });
    expect(report.results[0].calls[1]).toMatchObject({ status: "missing", usage: null, costUsd: null, error: { message: "call_limit" } });
  });
  it("preflights frozen private inputs and selected models without credentials or any provider call", async () => {
    const fixture = await privateFixture();
    const result = await runEvaluationCli({ argv: [fixture.manifest, "--preflight", "--json"], env: {
      EVALUATION_REPORT_PATH: path.join(fixture.directory, "preflight.json"),
      EVALUATION_PROVIDERS: "anthropic,openai", ANTHROPIC_CONTRACT_MODEL: "selected-a", OPENAI_CONTRACT_MODEL: "selected-b",
      EVALUATION_MAX_CALLS: "8", EVALUATION_MAX_GENERATED_TOKENS: "800", EVALUATION_GENERATED_TOKENS_PER_ATTEMPT: "100",
      EVALUATION_MAX_RETRIES: "1", EVALUATION_REPETITIONS: "2",
    } });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "preflight", providerCalls: 0, cases: 1, pages: 1, documents: 1,
      plan: { repetitions: 2, measurements: 8, maximumAttempts: 16, admittedMaximumAttempts: 8,
        limits: { maxCalls: 8, maxGeneratedTokens: 800, generatedTokensPerAttempt: 100, maxRetries: 1 },
        inputTokens: null, totalTokens: null, estimatedPriceUsd: null, hardMonetaryCap: false },
    });
    const raw = JSON.parse(await readFile(path.join(fixture.directory, "preflight.json"), "utf8"));
    expect(raw.plan.providers).toEqual([
      { provider: "anthropic", splitModel: "selected-a", extractModel: "selected-a" },
      { provider: "openai", splitModel: "selected-b", extractModel: "selected-b" },
    ]);
    expect(raw.provenance.datasetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(raw.dataset.cases[0].id).toBe("PRIVATE-BUSINESS-ID");
    for (const secret of [fixture.directory, "PRIVATE-", "12345678", "76543.21", "selected-a", "selected-b"]) expect(result.stdout).not.toContain(secret);
  });
  it("writes partial raw evidence privately and prints only safe aggregates with exit 2", async () => {
    const fixture = await privateFixture();
    const reportPath = path.join(fixture.directory, "private-report.json");
    const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { ...limits, EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "partial", cases: 1, documents: 1, results: [{ coverage: { extraction: { completed: 0, failed: 1, missing: 0 } }, criticalDocuments: { correct: 0, total: 1, missing: 1 } }] });
    const raw = JSON.parse(await readFile(reportPath, "utf8"));
    expect(raw.dataset.cases[0]).toMatchObject({ id: "PRIVATE-BUSINESS-ID", documents: [{ expected: { documentNumber: "PRIVATE-INVOICE-989" } }] });
    expect(raw.results[0].calls[1].error.message).toBe("PRIVATE-FAILURE-DATA");
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    for (const privateValue of [fixture.directory, "PRIVATE-", "12345678", "76543.21", "private-source"]) {
      expect(result.stdout).not.toContain(privateValue);
      expect(result.stderr).not.toContain(privateValue);
    }
  });
  it("refuses a raw report inside Git, including a symlinked directory, before any AI calls", async () => {
    const fixture = await privateFixture();
    let called = false;
    fixture.provider.split = async () => { called = true; throw new Error("unexpected call"); };
    await symlink(process.cwd(), path.join(fixture.directory, "repo-link"));
    for (const reportPath of [path.join(process.cwd(), "private-report-must-not-exist.json"), path.join(fixture.directory, "repo-link", "private-report-must-not-exist.json")]) {
      const result = await runEvaluationCli({ argv: [fixture.manifest], env: { ...limits, EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      await expect(stat(reportPath)).rejects.toThrow();
    }
    expect(called).toBe(false);
  });

  it("never overwrites an existing raw report", async () => {
    const fixture = await privateFixture();
    const reportPath = path.join(fixture.directory, "previous-report.json");
    await writeFile(reportPath, "previous private evidence");
    const result = await runEvaluationCli({ argv: [fixture.manifest], env: { ...limits, EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
    expect(result.exitCode).toBe(1);
    expect(await readFile(reportPath, "utf8")).toBe("previous private evidence");
  });

  it("returns complete and wholly failed process states without a percentage gate", async () => {
    const fixture = await privateFixture();
    fixture.provider.extract = async () => ({ model: "extract-v1", usage: { inputTokens: 4, outputTokens: 5 }, payload: { ...emptyDocumentPayload(), documentNumber: "wrong" } });
    const completed = await runEvaluationCli({ argv: [fixture.manifest], env: { ...limits, EVALUATION_REPORT_PATH: path.join(fixture.directory, "complete.json") }, providers: [{ provider: fixture.provider }] });
    expect(completed.exitCode).toBe(0);
    expect(completed.stdout).toContain("Run status: complete");
    expect(completed.stdout).toContain("Critical financial Documents: 0/1");
    fixture.provider.split = async () => { throw new Error("private failed Split"); };
    fixture.provider.extract = async () => { throw new Error("private failed Extraction"); };
    const failed = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { ...limits, EVALUATION_REPORT_PATH: path.join(fixture.directory, "failed.json") }, providers: [{ provider: fixture.provider }] });
    expect(failed.exitCode).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ status: "failed", results: [{ split: { total: 1, missing: 1 }, criticalDocuments: { total: 1, missing: 1 } }] });
  });

  it("also refuses raw output inside a bare Git repository", async () => {
    const fixture = await privateFixture();
    const bare = path.join(fixture.directory, "bare.git");
    await promisify(execFile)("git", ["init", "--bare", bare]);
    const result = await runEvaluationCli({ argv: [fixture.manifest], env: { ...limits, EVALUATION_REPORT_PATH: path.join(bare, "private-report.json") }, providers: [{ provider: fixture.provider }] });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    await expect(stat(path.join(bare, "private-report.json"))).rejects.toThrow();
  });

  it("changes dataset identity when the exact external reference or manifest bytes change", async () => {
    const fixture = await privateFixture();
    const paths = ["first.json", "changed-reference.json", "changed-manifest.json"].map(file => path.join(fixture.directory, file));
    const run = async (reportPath: string) => {
      const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { ...limits, EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
      expect(result.exitCode).toBe(2);
      return JSON.parse(await readFile(reportPath, "utf8"));
    };
    const first = await run(paths[0]);
    const referencePath = path.join(fixture.directory, "private-reference.json");
    await writeFile(referencePath, JSON.stringify(JSON.parse(await readFile(referencePath, "utf8")), null, 2));
    const changedReference = await run(paths[1]);
    await writeFile(fixture.manifest, JSON.stringify(JSON.parse(await readFile(fixture.manifest, "utf8")), null, 2));
    const changedManifest = await run(paths[2]);
    expect(new Set([first, changedReference, changedManifest].map(report => report.provenance.datasetHash)).size).toBe(3);
    expect(changedReference.provenance.manifestHash).toBe(first.provenance.manifestHash);
    expect(changedReference.dataset.cases[0].documents[0].referenceFileHash).not.toBe(first.dataset.cases[0].documents[0].referenceFileHash);
    expect(changedManifest.provenance.manifestHash).not.toBe(first.provenance.manifestHash);
    expect(changedManifest.results[0].calls[0].provenance.sourceHash).toBe(first.results[0].calls[0].provenance.sourceHash);
  });

  it("refuses ambiguous Git ownership errors before reserving raw output or calling a provider", async () => {
    const fixture = await privateFixture();
    const untrusted = path.join(fixture.directory, "private-untrusted-repository");
    await promisify(execFile)("git", ["init", "--quiet", untrusted]);
    const reportPath = path.join(untrusted, "private-report.json");
    let called = false;
    fixture.provider.split = async () => { called = true; throw new Error("unexpected provider call"); };
    // Exercise Git's real ownership refusal for the output repository. Trust
    // only the current source worktree in this process so a failed guard cannot
    // be masked by a later provenance failure. No global Git setting is changed.
    vi.stubEnv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1");
    vi.stubEnv("GIT_CONFIG_COUNT", "2");
    vi.stubEnv("GIT_CONFIG_KEY_0", "safe.directory");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "");
    vi.stubEnv("GIT_CONFIG_KEY_1", "safe.directory");
    vi.stubEnv("GIT_CONFIG_VALUE_1", await realpath(process.cwd()));
    try {
      await expect(promisify(execFile)("git", ["-C", untrusted, "rev-parse", "--absolute-git-dir"]))
        .rejects.toMatchObject({ code: 128, stderr: expect.stringContaining("detected dubious ownership") });
      const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { ...limits, EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(fixture.directory);
      expect(result.stderr).not.toContain("private-untrusted-repository");
      expect(called).toBe(false);
      await expect(stat(reportPath)).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });

  it("does not let caller Git discovery ceilings hide an enclosing output repository", async () => {
    const fixture = await privateFixture();
    const repository = path.join(fixture.directory, "private-repository");
    await promisify(execFile)("git", ["init", "--quiet", repository]);
    const reportPath = path.join(repository, "nested", "private-report.json");
    let called = false;
    fixture.provider.split = async () => { called = true; throw new Error("unexpected provider call"); };
    vi.stubEnv("GIT_CEILING_DIRECTORIES", await realpath(repository));
    try {
      const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { ...limits, EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(fixture.directory);
      expect(called).toBe(false);
      await expect(stat(reportPath)).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });

});
