import { expect, test } from "@playwright/test";
import { startInternalAuthTransportWeb } from "./support/internal-auth-transport";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { provisionBrowserAccountFixture } from "../tests/support/e2e";
import { createHash } from "node:crypto";

// Standalone real-Auth HTTP seam; this harness owns its Next process and gateway.
test.skip(process.env.AUTH_TRANSPORT_E2E !== "1", "Requires the isolated real-Auth transport harness");
const baseURL = "http://127.0.0.1:3103";
test.use({ baseURL });
let harness: Awaited<ReturnType<typeof startInternalAuthTransportWeb>>;
test.beforeAll(async () => { harness = await startInternalAuthTransportWeb(197, baseURL); });
test.afterAll(async () => { await harness?.close(); });

test("web liveness and internal Auth availability remain healthy when the public TLS path fails", async ({ request }) => {
  // Harness preflight proves public TLS fails; successful responses use real Auth.
  harness.gateway.paths.length = 0;
  const live = await request.get("/health/live", { maxRedirects: 0 });
  expect(live.status()).toBe(200);
  expect(await live.json()).toEqual({ status: "ok" });
  expect(live.headers()["cache-control"]).toBe("no-store");
  const auth = await request.get("/health/auth", { maxRedirects: 0 });
  expect(auth.status()).toBe(200);
  expect(await auth.json()).toEqual({ status: "available" });
  expect(auth.headers()["cache-control"]).toBe("no-store");
  expect(auth.headers()["set-cookie"]).toBeUndefined();
  expect(harness.gateway.paths).toEqual(["/auth/v1/settings"]);
});

test("dependency faults are bounded and never prevent liveness or touch an existing session", async ({ context, page }) => {
  const email = `availability-${crypto.randomUUID()}@example.test`;
  const password = "Availability-test-password";
  await provisionBrowserAccountFixture({ email, password, organizationName: "Availability" });
  const cookies = new Map<string, { value: string; options: CookieOptions }>();
  const client = createServerClient(harness.environment.NEXT_PUBLIC_SUPABASE_URL, harness.environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: { getAll: () => [...cookies].map(([name, cookie]) => ({ name, value: cookie.value })),
      setAll: updates => { for (const update of updates) cookies.set(update.name, update); } },
  });
  expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
  await context.addCookies([...cookies].map(([name, cookie]) => ({ name, value: cookie.value, url: baseURL })));
  const digests = () => context.cookies().then(values => values.map(({ name, value }) => ({ name, digest: createHash("sha256").update(value).digest("hex") })));
  const original = await digests();
  const { gateway } = harness;
  const check = async (status: number, body: object) => {
    const response = await page.goto("/health/auth");
    expect(response?.status()).toBe(status);
    expect(await response?.json()).toEqual(body);
    expect(response?.headers()["set-cookie"]).toBeUndefined();
    expect(response?.headers()["cache-control"]).toBe("no-store");
    const live = await page.goto("/health/live");
    expect(live?.status()).toBe(200);
    expect(await live?.json()).toEqual({ status: "ok" });
    expect(await digests()).toEqual(original);
  };
  // A healthy Auth probe does not imply the MFA/database path is healthy.
  gateway.paths.length = 0;
  gateway.unavailable(true, "/rest/v1");
  await check(200, { status: "available" });
  expect(gateway.paths).toEqual(["/auth/v1/settings"]);
  gateway.unavailable(true);
  await check(503, { status: "degraded" });
  gateway.unavailable(false);
  await check(200, { status: "available" });
  gateway.stall(true);
  const start = Date.now();
  await check(503, { status: "degraded" });
  expect(Date.now() - start).toBeLessThan(6_000);
  gateway.stall(false);
  await check(200, { status: "available" });
  // Close the real forwarding listener: no HTTP response and no public fallback.
  gateway.close();
  await check(503, { status: "degraded" });
  expect(gateway.paths.every(path => path === "/auth/v1/settings")).toBe(true);
});
