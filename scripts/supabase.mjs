#!/usr/bin/env node
// Runs the Supabase CLI against this checkout's own local stack.
//
// The main checkout uses supabase/config.toml as is. A linked git worktree gets
// its own stack: a generated workdir (.supabase-worktree/) with a distinct
// project_id and ports shifted by 100 × slot, so parallel worktrees can reset
// and test their databases without touching each other. The slot is derived
// from the worktree path; set SUPABASE_SLOT (1–99) to override it on a clash.
//
// After `start`, the stack's URL and keys are written to .env.local.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const root = git("rev-parse", "--show-toplevel");
const dotenv = path.join(root, ".env");
if (fs.existsSync(dotenv)) process.loadEnvFile(dotenv);
const supabaseEnv = {
  ...process.env,
  // Keep the local stack usable before a developer opts into Google. Real
  // credentials in the gitignored .env replace these non-secret placeholders.
  SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID:
    process.env.SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID || "local-google-client-id-not-configured",
  SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET:
    process.env.SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET || "local-google-client-secret-not-configured",
};
const isLinkedWorktree =
  fs.realpathSync(path.resolve(root, git("rev-parse", "--git-dir"))) !==
  fs.realpathSync(path.resolve(root, git("rev-parse", "--git-common-dir")));

// Services a worktree stack doesn't need; they only cost memory and start-up time.
const WORKTREE_DISABLED_SECTIONS = new Set(["studio", "analytics", "edge_runtime"]);

function worktreeSlot() {
  if (process.env.SUPABASE_SLOT) return Number(process.env.SUPABASE_SLOT);
  return 1 + (createHash("sha256").update(root).digest().readUInt32BE(0) % 99);
}

function prepareWorktreeWorkdir(slot) {
  const source = path.join(root, "supabase");
  const target = path.join(root, ".supabase-worktree", "supabase");
  fs.rmSync(path.dirname(target), { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source)) {
    if (entry === "config.toml" || entry.startsWith(".")) continue;
    // The CLI rejects email template symlinks that resolve outside the generated
    // worktree project root; copy templates while migrations and fixtures remain shared.
    if (entry === "templates") {
      fs.cpSync(path.join(source, entry), path.join(target, entry), { recursive: true });
    } else {
      fs.symlinkSync(path.join(source, entry), path.join(target, entry));
    }
  }

  let section = "";
  const config = fs
    .readFileSync(path.join(source, "config.toml"), "utf8")
    .split("\n")
    .map((line) => {
      const header = line.match(/^\[([^\]]+)\]/);
      if (header) section = header[1];
      if (/^project_id = /.test(line)) return `project_id = "ivat-wt${slot}"`;
      if (WORKTREE_DISABLED_SECTIONS.has(section) && /^enabled = true/.test(line)) return "enabled = false";
      if (/^additional_redirect_urls = \[$/.test(line) && process.env.SUPABASE_E2E_REDIRECT_URL) {
        return `${line}\n  ${JSON.stringify(process.env.SUPABASE_E2E_REDIRECT_URL)},`;
      }
      return line.replace(
        /^((?:port|shadow_port|inspector_port) = )(\d+)/,
        (_, key, port) => `${key}${Number(port) + 100 * slot}`,
      );
    })
    .join("\n");
  fs.writeFileSync(path.join(target, "config.toml"), config);
  return path.dirname(target);
}

const supabase = path.join(root, "node_modules", ".bin", "supabase");
const args = process.argv.slice(2);
const generatedWorkdir = path.join(root, ".supabase-worktree");
const shouldPrepareWorkdir = args[0] === "start" || !fs.existsSync(path.join(generatedWorkdir, "supabase", "config.toml"));
const workdirArgs = isLinkedWorktree
  ? ["--workdir", shouldPrepareWorkdir ? prepareWorktreeWorkdir(worktreeSlot()) : generatedWorkdir]
  : [];

const { status } = spawnSync(supabase, [...args, ...workdirArgs], {
  stdio: "inherit",
  cwd: root,
  env: supabaseEnv,
});
if (status !== 0) process.exit(status ?? 1);

if (args[0] === "start") writeEnvLocal();

function writeEnvLocal() {
  const stack = JSON.parse(
    execFileSync(supabase, ["status", "-o", "json", ...workdirArgs], {
      cwd: root,
      env: supabaseEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const managed = {
    NEXT_PUBLIC_SUPABASE_URL: stack.API_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: stack.PUBLISHABLE_KEY,
    DATABASE_URL: stack.DB_URL,
    SUPABASE_SECRET_KEY: stack.SECRET_KEY,
  };
  // Settings the developer may change; written only when missing.
  const appOrigin = isLinkedWorktree ? "http://127.0.0.1:3100" : "http://127.0.0.1:3000";
  const defaults = {
    AI_PROVIDER: "fake",
    APP_ORIGIN: appOrigin,
    AUTH_REDIRECT_ALLOWLIST: `${appOrigin}/auth/callback`,
  };
  const file = path.join(root, ".env.local");
  const kept = fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line && !Object.keys(managed).some((key) => line.startsWith(`${key}=`)))
    : [];
  const missingDefaults = Object.entries(defaults).filter(([key]) => !kept.some((line) => line.startsWith(`${key}=`)));
  const lines = [...kept, ...[...missingDefaults, ...Object.entries(managed)].map(([key, value]) => `${key}=${value}`)];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  console.log(`Wrote local Supabase settings to ${path.relative(process.cwd(), file) || ".env.local"}`);
}
