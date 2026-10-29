#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "src/lib/database.types.ts");
const generator = path.join(root, "scripts/supabase.mjs");

const result = spawnSync(process.execPath, [generator, "gen", "types", "typescript", "--local"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const normalized = result.stdout.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
fs.writeFileSync(output, normalized.endsWith("\n") ? normalized : `${normalized}\n`);
