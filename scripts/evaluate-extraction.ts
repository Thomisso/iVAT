import { readFile } from "node:fs/promises";
import path from "node:path";
import { anthropicAiProvider } from "@/ai/anthropic";
import { openAiProvider } from "@/ai/openai";
import { pdfPages } from "@/application/source-files";
import {
  evaluateGoldenSet,
  formatEvaluationReport,
  loadGoldenSet,
  type EvaluationProvider,
} from "@/evaluation/extraction-evaluation";

type ProviderName = "anthropic" | "openai";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} to run the extraction evaluation`);
  return value;
}

function selectedProviders(): ProviderName[] {
  const selected = process.env.EVALUATION_PROVIDERS?.split(",").map((name) => name.trim()).filter(Boolean);
  if (selected?.length) {
    for (const name of selected) {
      if (name !== "anthropic" && name !== "openai") {
        throw new Error(`Unknown EVALUATION_PROVIDERS entry ${JSON.stringify(name)}`);
      }
    }
    return selected as ProviderName[];
  }
  const inferred: ProviderName[] = [];
  if (process.env.ANTHROPIC_CONTRACT_API_KEY) inferred.push("anthropic");
  if (process.env.OPENAI_CONTRACT_API_KEY) inferred.push("openai");
  if (inferred.length === 0) {
    throw new Error(
      "Set EVALUATION_PROVIDERS=anthropic,openai and the matching *_CONTRACT_API_KEY and *_CONTRACT_MODEL values",
    );
  }
  return inferred;
}

function providersFromEnvironment(): EvaluationProvider[] {
  return selectedProviders().map((name) => {
    if (name === "anthropic") {
      const fallbackModel = required("ANTHROPIC_CONTRACT_MODEL");
      return {
        label: "anthropic",
        provider: anthropicAiProvider({
          apiKey: required("ANTHROPIC_CONTRACT_API_KEY"),
          splitModel: process.env.ANTHROPIC_EVALUATION_SPLIT_MODEL?.trim() || fallbackModel,
          extractModel: process.env.ANTHROPIC_EVALUATION_EXTRACT_MODEL?.trim() || fallbackModel,
        }),
      };
    }
    const fallbackModel = required("OPENAI_CONTRACT_MODEL");
    return {
      label: "openai",
      provider: openAiProvider({
        apiKey: required("OPENAI_CONTRACT_API_KEY"),
        splitModel: process.env.OPENAI_EVALUATION_SPLIT_MODEL?.trim() || fallbackModel,
        extractModel: process.env.OPENAI_EVALUATION_EXTRACT_MODEL?.trim() || fallbackModel,
      }),
    };
  });
}

async function main() {
  const argument = process.argv.slice(2).find((value) => !value.startsWith("--"));
  const manifestPath = path.resolve(argument ?? "evaluation/golden-set/manifest.json");
  const goldenSet = await loadGoldenSet(manifestPath);
  if (goldenSet.cases.length === 0) throw new Error("The golden set contains no cases");
  const report = await evaluateGoldenSet(
    goldenSet,
    providersFromEnvironment(),
    async (sourcePath) => new Uint8Array(await readFile(sourcePath)),
    async (bytes, source, pages) => {
      if (source.format !== "pdf") return bytes;
      if (pages.firstPage === 1 && pages.lastPage === source.pageCount) return bytes;
      return pdfPages(bytes, pages);
    },
  );
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(formatEvaluationReport(report));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Extraction evaluation failed: ${message}\n`);
  process.exitCode = 1;
});
