import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AiInput } from "@/application/ai-provider";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const hashBytes = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export const hashValue = (value: unknown): string => hashBytes(JSON.stringify(value));
export type EvaluationRevision = { commit: string; dirty: boolean; sourceHash: string };

/** Commit plus the exact installed application/evaluator source, including local edits. */
export async function evaluationRevision(): Promise<EvaluationRevision> {
  const git = async (...args: string[]) => (await execute("git", args, { cwd: root })).stdout.trim();
  const commit = await git("rev-parse", "HEAD");
  const dirty = (await git("status", "--porcelain")).length > 0;
  const files = (await git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src", "scripts/evaluate-extraction.ts", "package.json", "package-lock.json"))
    .split("\0").filter(Boolean).sort();
  const sources = await Promise.all(files.map(async file => [file, hashBytes(await readFile(path.join(root, file)))]));
  return { commit, dirty, sourceHash: hashValue(sources) };
}

/** Includes the actual derivative pixels and their ordered geometry, not just the PDF. */
export function inputHash(input: AiInput): string {
  return hashValue({ format: input.format, mediaType: input.mediaType, pageCount: input.pageCount,
    bytes: hashBytes(input.bytes), text: input.text ?? null,
    pageImages: input.pageImages?.map(page => ({ mediaType: page.mediaType, width: page.width, height: page.height, hash: hashBytes(page.bytes) })) ?? null });
}
