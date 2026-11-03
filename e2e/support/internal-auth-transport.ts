import { spawn } from "node:child_process";
import { readFileSync, openSync, closeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "@playwright/test";
import { supabaseHttpGateway } from "../../tests/support/supabase-http-gateway";

/** Owns only this checkout's Next process and a failure-injecting HTTP hop.
 * Successful responses always come from the running local Supabase stack. */
export async function startInternalAuthTransportWeb(ticket: number, baseURL = "http://127.0.0.1:3103") {
  const environment = Object.fromEntries(readFileSync(".env.local", "utf8").split("\n").filter(Boolean).map(line => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const gateway = await supabaseHttpGateway(environment.NEXT_PUBLIC_SUPABASE_URL);
  const brokenPublicUrl = environment.NEXT_PUBLIC_SUPABASE_URL.replace("http:", "https:");
  await expect(fetch(`${brokenPublicUrl}/auth/v1/settings`)).rejects.toThrow();
  const logPath = `/tmp/ivat-${ticket}-transport-next.log`;
  const log = openSync(logPath, "w");
  const publicOrigin = new URL(baseURL).origin;
  const mailpit = new URL(environment.NEXT_PUBLIC_SUPABASE_URL);
  mailpit.port = String(Number(mailpit.port) + 3);
  const web = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", new URL(baseURL).port], {
    env: { ...process.env, ...environment, NEXT_PUBLIC_SUPABASE_URL: brokenPublicUrl, SUPABASE_INTERNAL_URL: gateway.url,
      APP_ORIGIN: publicOrigin, AUTH_REDIRECT_ALLOWLIST: `${publicOrigin}/auth/callback`, NEXT_TELEMETRY_DISABLED: "1",
      SMTP_HOST: "127.0.0.1", SMTP_PORT: String(Number(new URL(mailpit).port) + 1), SMTP_LOCAL_CAPTURE: "true" },
    stdio: ["ignore", log, log],
  });
  async function close() {
    web.kill("SIGTERM");
    if (web.exitCode === null) await Promise.race([new Promise(resolve => web.once("exit", resolve)), delay(5_000)]);
    gateway.close();
    closeSync(log);
  }
  try {
    await expect.poll(async () => {
      if (web.exitCode !== null) throw new Error(`Transport Next server exited; see ${logPath}`);
      return fetch(`${baseURL}/login`).then(response => response.status).catch(() => 0);
    }, { timeout: 60_000 }).toBe(200);
  } catch (error) { await close(); throw error; }
  return { environment, gateway, logPath, mailpit: mailpit.toString().replace(/\/$/, ""), close };
}
