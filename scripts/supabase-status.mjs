import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/** Select this checkout's stack identically for public CLI and private consumers. */
export function localSupabaseContext({ cwd = process.cwd(), env = process.env } = {}) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const root = git("rev-parse", "--show-toplevel");
  const dotenv = path.join(root, ".env");
  const environment = { ...(fs.existsSync(dotenv) ? parseEnv(fs.readFileSync(dotenv, "utf8")) : {}), ...env };
  const isLinkedWorktree = fs.realpathSync(path.resolve(root, git("rev-parse", "--git-dir"))) !== fs.realpathSync(path.resolve(root, git("rev-parse", "--git-common-dir")));
  return { root, env: environment, isLinkedWorktree, generatedWorkdir: path.join(root, ".supabase-worktree") };
}

/**
 * Private, in-process credential transport. Never forwards child output, even
 * when spawn, status or JSON decoding fails. Public CLI output remains redacted.
 * @returns {Record<string, string>}
 */
export function readSupabaseStatus(options = {}) {
  const context = localSupabaseContext(options);
  const args = ["status", "-o", "json", ...(context.isLinkedWorktree ? ["--workdir", context.generatedWorkdir] : [])];
  const result = spawnSync(path.join(context.root, "node_modules/.bin/supabase"), args, {
    cwd: context.root, env: context.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000,
  });
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error(`Local Supabase status failed (status=${result.status}, signal=${result.signal ?? "none"}, code=${result.error?.code ?? "none"})`);
  }
  let status;
  try { status = JSON.parse(result.stdout); } catch { throw new Error("Local Supabase status returned invalid JSON"); }
  const required = ["API_URL", "PUBLISHABLE_KEY", "SECRET_KEY", "DB_URL", "JWT_SECRET"];
  if (!status || typeof status !== "object" || Array.isArray(status) || required.some(key => typeof status[key] !== "string" || !status[key])) {
    throw new Error("Local Supabase status is missing required configuration");
  }
  return status;
}
