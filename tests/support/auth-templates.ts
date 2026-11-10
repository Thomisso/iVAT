import { execFileSync, spawnSync } from "node:child_process";
import { inject } from "vitest";
import { startOwningStackAgain } from "../../scripts/auth-startup.mjs";

/** Probe templates through the real Auth container of this test stack only. */
export function nativeAuthTemplateFixture(name: "recovery" | "magic_link") {
  const port = new URL(inject("supabaseUrl")).port;
  const gateway = execFileSync("docker", ["ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim();
  if (!/^supabase_kong_[a-zA-Z0-9_-]+$/.test(gateway)) throw new Error("Owning Supabase gateway required");
  const auth = gateway.replace("supabase_kong_", "supabase_auth_");
  const runtimeIdentity = execFileSync("docker", ["inspect", "--format", "{{.Id}} {{.State.StartedAt}}", gateway, auth], { encoding: "utf8" }).trim();
  const response = spawnSync("docker", ["exec", auth, "wget", "-q", "-O", "-", `http://${gateway}:8088/email/${name}.html`], { encoding: "utf8", timeout: 10_000 });
  return { ok: response.status === 0, body: response.stdout, runtimeIdentity };
}

/** Run the actual existing-stack startup path; suppress its private local keys. */
export function startOwningStackAgainFixture() {
  startOwningStackAgain();
}
