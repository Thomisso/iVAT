import { execFile } from "node:child_process";
import { mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { anthropicAiProvider } from "@/ai/anthropic";
import { openAiProvider } from "@/ai/openai";
import { pdfPages } from "@/application/source-files";
import { evaluateGoldenSet, formatEvaluationReport, loadGoldenSet, safeEvaluationSummary, type EvaluationProvider } from "./extraction-evaluation";
import { hashBytes } from "./evaluation-provenance";

const execute = promisify(execFile);
type Environment = Record<string, string | undefined>;
type ProviderName = "anthropic" | "openai";

async function providersFromEnvironment(env: Environment): Promise<EvaluationProvider[]> {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error("evaluation_configuration_missing");
    return value;
  };
  const selected = env.EVALUATION_PROVIDERS?.split(",").map(name => name.trim()).filter(Boolean)
    ?? (["anthropic", "openai"] as const).filter(name => env[`${name.toUpperCase()}_CONTRACT_API_KEY`]);
  if (!selected.length || selected.some(name => name !== "anthropic" && name !== "openai")) throw new Error("evaluation_configuration_invalid");
  return Promise.all((selected as ProviderName[]).map(async name => {
    const prefix = name.toUpperCase();
    const fallback = required(`${prefix}_CONTRACT_MODEL`);
    const configuration = { splitModel: env[`${prefix}_EVALUATION_SPLIT_MODEL`]?.trim() || fallback,
      extractModel: env[`${prefix}_EVALUATION_EXTRACT_MODEL`]?.trim() || fallback };
    const adapter = hashBytes(await readFile(fileURLToPath(new URL(`../ai/${name}.ts`, import.meta.url))));
    return { label: name, identity: { adapter, configuration },
      provider: (name === "anthropic" ? anthropicAiProvider : openAiProvider)({ ...configuration, apiKey: required(`${prefix}_CONTRACT_API_KEY`) }) };
  }));
}

/** Raw output must resolve outside every Git worktree, even through a symlink. */
async function privateOutput(output: string | undefined) {
  if (!output?.trim()) throw new Error("evaluation_private_output_required");
  const destination = path.resolve(output);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const directory = await realpath(path.dirname(destination));
  let insideGit = false;
  try {
    await execute("git", ["-C", directory, "rev-parse", "--absolute-git-dir"]);
    insideGit = true;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === 128)) throw error;
  }
  if (insideGit) throw new Error("evaluation_private_output_inside_git");
  const canonical = path.join(directory, path.basename(destination));
  // Exclusive creation refuses an existing file or symlink and reserves the
  // destination before AI work; the raw report is never written to stdout.
  return { file: await open(canonical, "wx", 0o600), path: canonical };
}

export type EvaluationCliOptions = { argv: string[]; env: Environment; providers?: EvaluationProvider[] };

/** Shared CLI boundary; tests inject only external provider adapters. */
export async function runEvaluationCli(options: EvaluationCliOptions): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let output: Awaited<ReturnType<typeof privateOutput>> | undefined;
  let written = false;
  try {
    if (options.argv.some(value => value.startsWith("--") && value !== "--json")
      || options.argv.filter(value => !value.startsWith("--")).length > 1) throw new Error("evaluation_arguments_invalid");
    output = await privateOutput(options.env.EVALUATION_REPORT_PATH);
    const manifestPath = path.resolve(options.argv.find(value => !value.startsWith("--")) ?? "evaluation/golden-set/manifest.json");
    const goldenSet = await loadGoldenSet(manifestPath);
    const report = await evaluateGoldenSet(goldenSet, options.providers ?? await providersFromEnvironment(options.env),
      async sourcePath => new Uint8Array(await readFile(sourcePath)),
      async (bytes, source, pages) => source.format !== "pdf" || pages.firstPage === 1 && pages.lastPage === source.pageCount ? bytes : pdfPages(bytes, pages));
    await output.file.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await output.file.sync();
    written = true;
    return { stdout: options.argv.includes("--json") ? `${JSON.stringify(safeEvaluationSummary(report), null, 2)}\n` : formatEvaluationReport(report),
      stderr: "", exitCode: report.status === "complete" ? 0 : report.status === "partial" ? 2 : 1 };
  } catch {
    // Errors may contain confidential case IDs, source paths or provider data.
    return { stdout: "", stderr: "Extraction evaluation failed. Check the private inputs, output destination and provider configuration.\n", exitCode: 1 };
  } finally {
    if (output) {
      await output.file.close();
      if (!written) await unlink(output.path);
    }
  }
}
