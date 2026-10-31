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
const supabaseEnv = { ...process.env };
const isLinkedWorktree =
  fs.realpathSync(path.resolve(root, git("rev-parse", "--git-dir"))) !==
  fs.realpathSync(path.resolve(root, git("rev-parse", "--git-common-dir")));

// Services a worktree stack doesn't need; they only cost memory and start-up time.
const WORKTREE_DISABLED_SECTIONS = new Set(["studio", "analytics", "edge_runtime"]);
const SERVICE_PROFILES = {
  // Browser acceptance needs Auth, Storage and Mailpit, but not the local
  // dashboards, observability stack, Edge Functions, image proxy or pooler.
  e2e: ["studio", "logflare", "vector", "edge-runtime", "imgproxy", "supavisor"],
};

function expandServiceProfile(rawArgs) {
  const profileArgument = rawArgs.find((argument) => argument.startsWith("--profile="));
  if (!profileArgument) return rawArgs;
  const profile = profileArgument.slice("--profile=".length);
  if (rawArgs[0] !== "start") {
    throw new Error("A Supabase service profile can only be used with start");
  }
  if (!(profile in SERVICE_PROFILES)) {
    throw new Error(`Unknown Supabase service profile: ${profile}`);
  }
  if (rawArgs.includes("-x") || rawArgs.includes("--exclude")) {
    throw new Error("A Supabase service profile cannot be combined with an explicit exclusion list");
  }
  return [
    ...rawArgs.filter((argument) => argument !== profileArgument),
    "-x",
    SERVICE_PROFILES[profile].join(","),
  ];
}

function worktreeSlot() {
  if (process.env.SUPABASE_SLOT) return Number(process.env.SUPABASE_SLOT);
  return 1 + (createHash("sha256").update(root).digest().readUInt32BE(0) % 99);
}

// Kong binds individual template files. Replacing their directory or unlinking
// existing files leaves a running container with dead mounts on repeated start.
function copyTemplatesInPlace(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTemplatesInPlace(from, to);
    else fs.writeFileSync(to, fs.readFileSync(from));
  }
}

function prepareWorktreeWorkdir(slot) {
  const source = path.join(root, "supabase");
  const target = path.join(root, ".supabase-worktree", "supabase");
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source)) {
    if (entry === "config.toml" || entry.startsWith(".")) continue;
    // The CLI rejects email template symlinks that resolve outside the generated
    // worktree project root; copy templates while migrations and fixtures remain shared.
    if (entry === "templates") {
      copyTemplatesInPlace(path.join(source, entry), path.join(target, entry));
    } else {
      const from = path.join(source, entry);
      const to = path.join(target, entry);
      const current = fs.existsSync(to) && fs.lstatSync(to).isSymbolicLink() && fs.readlinkSync(to) === from;
      if (!current) {
        fs.rmSync(to, { recursive: true, force: true });
        fs.symlinkSync(from, to);
      }
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
        /^((?:port|shadow_port|inspector_port|smtp_port|pop3_port) = )(\d+)/,
        (_, key, port) => `${key}${Number(port) + 100 * slot}`,
      );
    })
    .join("\n");
  fs.writeFileSync(path.join(target, "config.toml"), config);
  return path.dirname(target);
}

const supabase = path.join(root, "node_modules", ".bin", "supabase");
let args;
try {
  args = expandServiceProfile(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
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
  const configurationFile = path.join(isLinkedWorktree ? generatedWorkdir : root, "supabase", "config.toml");
  const smtpSection = fs.readFileSync(configurationFile, "utf8").match(/\[local_smtp\]([^]*?)(?=\n\[|$)/)?.[1];
  const smtpPort = smtpSection?.match(/^smtp_port = (\d+)/m)?.[1];
  const managed = {
    NEXT_PUBLIC_SUPABASE_URL: stack.API_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: stack.PUBLISHABLE_KEY,
    DATABASE_URL: stack.DB_URL,
    SUPABASE_SECRET_KEY: stack.SECRET_KEY,
    ...(smtpPort && stack.MAILPIT_URL ? {
      SMTP_HOST: "127.0.0.1", SMTP_PORT: smtpPort,
      SMTP_LOCAL_CAPTURE: "true", SMTP_ADMIN_EMAIL: "noreply@ivat.cz",
    } : {}),
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
