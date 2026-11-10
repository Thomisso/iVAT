import { spawnSync } from "node:child_process";
import { redactCliOutput } from "./cli-output.mjs";

/** Run the owning stack's existing startup path; success stays silent. */
export function startOwningStackAgain({ command = process.execPath, args = ["scripts/supabase.mjs", "start", "--profile=e2e"], timeout = 20_000 } = {}) {
  const before = performance.now();
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout, maxBuffer: 256 * 1024,
  });
  const elapsed = Math.round(performance.now() - before);
  if (result.status === 0 && !result.error && !result.signal) return;
  // Redact before slicing: a tail must never discard a secret's identifying label.
  const overflow = result.error?.code === "ENOBUFS";
  const safe = overflow ? "[output omitted: capture limit exceeded]"
    : redactCliOutput([result.stdout ?? "", result.stderr ?? ""].join("\n"));
  const output = Buffer.from(safe).subarray(-2048).toString("utf8").trim();
  const kind = overflow ? "output_limit" : result.error?.code === "ETIMEDOUT" ? "timeout"
    : result.error ? "spawn_error" : result.signal ? "signal" : "nonzero_exit";
  throw new Error(`Owning stack repeated startup failed: ${kind}; elapsed_ms=${elapsed}; status=${result.status}; signal=${result.signal ?? "none"}; code=${result.error?.code ?? "none"}${output ? `\n${output}` : ""}`);
}
