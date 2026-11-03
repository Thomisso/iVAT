import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, openSync, closeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { expect, test } from "@playwright/test";
import { provisionBrowserAccountFixture } from "../tests/support/e2e";
import { totp } from "../tests/support/totp";
import { supabaseHttpGateway } from "../tests/support/supabase-http-gateway";

// This focused harness owns a Next dev process. Run separately from the ordinary
// acceptance runner: AUTH_TRANSPORT_E2E=1 SUPABASE_SLOT=<own slot> npx playwright
// test e2e/internal-auth-transport.spec.ts. The local stack must already be running.
test.skip(process.env.AUTH_TRANSPORT_E2E !== "1", "Requires the isolated real-Auth transport harness");
const baseURL = "http://127.0.0.1:3103";
test.use({ baseURL });
let web: ChildProcess;
let gateway: Awaited<ReturnType<typeof supabaseHttpGateway>>;
let environment: Record<string, string>;
let log: number;

test.beforeAll(async () => {
  environment = Object.fromEntries(readFileSync(".env.local", "utf8").split("\n").filter(Boolean).map(line => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  gateway = await supabaseHttpGateway(environment.NEXT_PUBLIC_SUPABASE_URL);
  const brokenPublicUrl = environment.NEXT_PUBLIC_SUPABASE_URL.replace("http:", "https:");
  await expect(fetch(`${brokenPublicUrl}/auth/v1/settings`)).rejects.toThrow();
  log = openSync("/tmp/ivat-195-transport-next.log", "w");
  web = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", "3103"], {
    env: { ...process.env, ...environment, NEXT_PUBLIC_SUPABASE_URL: brokenPublicUrl, SUPABASE_INTERNAL_URL: gateway.url,
      APP_ORIGIN: baseURL, AUTH_REDIRECT_ALLOWLIST: `${baseURL}/auth/callback`, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", log, log],
  });
  await expect.poll(async () => {
    if (web.exitCode !== null) throw new Error("Transport Next server exited; see /tmp/ivat-195-transport-next.log");
    return fetch(`${baseURL}/login`).then(response => response.status).catch(() => 0);
  }, { timeout: 60_000 }).toBe(200);
});

test.afterAll(async () => {
  web?.kill("SIGTERM");
  if (web && web.exitCode === null) await Promise.race([new Promise(resolve => web.once("exit", resolve)), delay(5_000)]);
  gateway?.close();
  if (log !== undefined) closeSync(log);
});

test("the old public cookie refreshes through private transport, survives an outage and supports browser password/login/logout", async ({ context, page }) => {
  const email = `transport-browser-${crypto.randomUUID()}@example.test`;
  const password = "Transport-browser-password";
  await provisionBrowserAccountFixture({ email, password, organizationName: "Transport browser" });
  const cookies = new Map<string, { value: string; options: CookieOptions }>();
  const old = createServerClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: { getAll: () => [...cookies].map(([name, cookie]) => ({ name, value: cookie.value })), setAll: updates => {
      for (const update of updates) cookies.set(update.name, update);
    } },
  });
  expect((await old.auth.signInWithPassword({ email, password })).error).toBeNull();
  const original = cookies.get("sb-127-auth-token")!;
  const session = JSON.parse(Buffer.from(original.value.slice(7), "base64url").toString());
  const originalSessionId = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString()).session_id;
  session.expires_at = 1;
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "en", url: baseURL },
    { name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, url: baseURL, sameSite: "Lax", httpOnly: false },
  ]);
  expect((await page.goto("/settings/security"))?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Security", exact: true })).toBeVisible();
  const authCookies = () => context.cookies().then(values => values.filter(cookie => cookie.name.startsWith("sb-")));
  const refreshed = await authCookies();
  expect(refreshed.every(cookie => cookie.name.startsWith("sb-127-auth-token"))).toBe(true);
  const refreshedSession = JSON.parse(Buffer.from(refreshed.sort((a, b) => a.name.localeCompare(b.name)).map(cookie => cookie.value).join("").slice(7), "base64url").toString());
  expect(refreshedSession.expires_at).toBeGreaterThan(Date.now() / 1_000);
  expect(JSON.parse(Buffer.from(refreshedSession.access_token.split(".")[1], "base64url").toString()).session_id).toBe(originalSessionId);
  gateway.unavailable(true);
  const failure = await page.goto("/settings/security");
  expect(failure?.status()).toBe(503);
  await expect(page.locator("body")).toContainText("Session verification is temporarily unavailable");
  await expect(page.getByRole("heading", { name: "Security", exact: true })).toHaveCount(0);
  const cookieState = (values: typeof refreshed) => values.map(({ name, value }) => ({ name, digest: createHash("sha256").update(value).digest("hex") }));
  expect(cookieState(await authCookies())).toEqual(cookieState(refreshed));
  gateway.unavailable(false);
  await page.goto("/settings/security");
  await expect(page.getByRole("heading", { name: "Security", exact: true })).toBeVisible();
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page.getByLabel("New password", { exact: true }).fill("Changed-transport-password");
  await page.getByLabel("Confirm new password", { exact: true }).fill("Changed-transport-password");
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await expect(page.getByText("Password changed. You are still signed in here.", { exact: true })).toBeVisible();
  await page.goto("/companies/new");
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/login`);
  expect((await authCookies()).map(cookie => cookie.name)).toEqual([]);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Changed-transport-password");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  expect(gateway.paths.some(path => path.includes("grant_type=refresh_token"))).toBe(true);
  expect(gateway.paths.some(path => path.includes("/logout"))).toBe(true);
  expect(gateway.paths.some(path => path.includes("/auth/v1/settings"))).toBe(true);
  expect(await page.locator("body").innerText()).not.toContain(gateway.url);
  await page.goto("/settings/security");
  await page.getByRole("link", { name: "Enable authenticator", exact: true }).click();
  await page.getByRole("button", { name: "Start setup", exact: true }).click();
  const secret = await page.locator("code").textContent();
  if (!secret) throw new Error("Native MFA setup key missing");
  await page.getByLabel("Authenticator code", { exact: true }).fill(totp(secret));
  await page.getByRole("button", { name: "Verify and enable", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "I saved the codes", exact: true }).click();
  await page.goto("/companies/new");
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/login`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Changed-transport-password");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/mfa/verify`);
  await page.goto("/companies/new");
  await expect(page).toHaveURL(`${baseURL}/mfa/verify`);
  await page.getByLabel("Authenticator code", { exact: true }).fill(totp(secret, Date.now() + 30_000));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  await page.goto("/settings/security");
  await expect(page.getByText("Two-factor authentication is enabled.", { exact: true })).toBeVisible();
});
