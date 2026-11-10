#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localSupabaseContext } from "./supabase-status.mjs";
import { redactCliOutput } from "./cli-output.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "src/lib/database.types.ts");
const context = localSupabaseContext({ cwd: root });
const generator = path.join(root, "node_modules/.bin/supabase");
const args = ["gen", "types", "typescript", "--local", ...(context.isLinkedWorktree ? ["--workdir", context.generatedWorkdir] : [])];

const result = spawnSync(generator, args, {
  cwd: root,
  encoding: "utf8",
  env: context.env,
  stdio: ["ignore", "pipe", "pipe"],
});

// Generated source is private machine output: redacting it changes valid types.
// Only diagnostics cross the public output boundary, including failure paths.
// A failed capture can end mid-credential; publish metadata without those bytes.
if (!result.error && result.stderr) process.stderr.write(redactCliOutput(result.stderr));
if (result.error || result.signal || result.status !== 0) {
  console.error(`Database type generation failed (status=${result.status}, signal=${result.signal ?? "none"}, code=${result.error?.code ?? "none"})`);
  process.exit(result.status ?? 1);
}

const normalized = result.stdout.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
fs.writeFileSync(output, normalized.endsWith("\n") ? normalized : `${normalized}\n`);
