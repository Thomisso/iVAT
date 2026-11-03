import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { afterEach, expect, inject, it, vi } from "vitest";
import { asUserClient } from "@/application/client";
import { currentUserId, logIn, logOut } from "@/application/auth";
import { createSupabaseTransport } from "@/lib/supabase/transport";
import { createSessionClient } from "@/lib/supabase/session-client";
import { provisionedUser } from "./support/clients";
import { supabaseHttpGateway } from "./support/supabase-http-gateway";

function cookieJar() {
  const stored = new Map<string, { value: string; options: CookieOptions }>();
  return {
    stored,
    snapshot: () => [...stored].map(([name, cookie]) => ({ name, digest: createHash("sha256").update(cookie.value).digest("hex") })),
    getAll: () => [...stored].map(([name, cookie]) => ({ name, value: cookie.value })),
    setAll: (values: { name: string; value: string; options: CookieOptions }[]) => {
      for (const cookie of values) {
        if (cookie.options.maxAge === 0) stored.delete(cookie.name);
        else stored.set(cookie.name, cookie);
      }
    },
  };
}

it("keeps an existing public-identity cookie usable and refreshable through internal Auth when the public TLS path is broken", async () => {
  const user = await provisionedUser("Internal transport");
  const url = inject("supabaseUrl");
  const publicUrl = url.replace("http:", "https:");
  // This is a real TLS protocol failure against the local HTTP gateway.
  await expect(fetch(`${publicUrl}/auth/v1/settings`)).rejects.toThrow();
  const cookies = cookieJar();
  const old = createServerClient(url, inject("supabaseAnonKey"), { cookies });
  expect(await logIn(asUserClient(old), { email: user.email, password: "correct-horse-battery" })).toEqual({ ok: true, value: null });
  expect((await old.auth.updateUser({ data: { cookieCompatibility: "x".repeat(5_000) } })).error).toBeNull();
  const names = [...cookies.stored.keys()];
  expect(names).toContain("sb-127-auth-token.0");
  const client = asUserClient(createSessionClient(publicUrl, inject("supabaseAnonKey"), {
    cookies,
    fetch: createSupabaseTransport({ publicUrl, internalUrl: url }),
  }));
  expect(await currentUserId(client)).toBe(user.userId);
  expect((await client.auth.refreshSession()).error).toBeNull();
  expect([...cookies.stored.keys()].every(name => /^sb-127-auth-token\.\d+$/.test(name))).toBe(true);
  expect(cookies.stored.get(names[0])?.options).toMatchObject({ path: "/", sameSite: "lax", httpOnly: false, maxAge: 34560000 });
  expect((await client.rpc("current_user_can_use_application")).data).toBe(true);
});

afterEach(() => vi.restoreAllMocks());

it("refuses verification and logout during internal outage without deleting an existing session or falling back, then restores the same session", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const user = await provisionedUser("Preserved session");
  const proxy = await supabaseHttpGateway(inject("supabaseUrl"));
  try {
    const publicUrl = inject("supabaseUrl").replace("http:", "https:");
    const cookies = cookieJar();
    const targets: string[] = [];
    const transport = createSupabaseTransport({ publicUrl, internalUrl: proxy.url, fetch: (input, init) => {
      targets.push(String(input instanceof Request ? input.url : input));
      return fetch(input, init);
    } });
    const requestClient = () => asUserClient(createSessionClient(publicUrl, inject("supabaseAnonKey"), { cookies, fetch: transport }));
    expect(await logIn(requestClient(), { email: user.email, password: "correct-horse-battery" })).toEqual({ ok: true, value: null });
    const before = cookies.snapshot();
    proxy.unavailable(true);
    await expect(currentUserId(requestClient())).rejects.toThrow("auth_unavailable");
    expect(await logOut(requestClient())).toEqual({ ok: false, error: "auth_unavailable" });
    expect(cookies.snapshot()).toEqual(before);
    expect(await logIn(requestClient(), { email: user.email, password: "correct-horse-battery" })).toEqual({ ok: false, error: "login_unavailable" });
    expect(cookies.snapshot()).toEqual(before);
    expect(targets.every(target => target.startsWith(`${proxy.url}/`))).toBe(true);
    proxy.unavailable(false);
    expect(await currentUserId(requestClient())).toBe(user.userId);
    expect((await requestClient().auth.refreshSession()).error).toBeNull();
    expect(await logOut(requestClient())).toEqual({ ok: true, value: null });
    expect(cookies.getAll().map(cookie => cookie.name)).toEqual([]);
  } finally {
    proxy.close();
  }
});

it("uses real internal Auth for native MFA, password maintenance and public OAuth links, distinguishing an outage from an invalid MFA code", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { beginTotpEnrollment, completeTotpEnrollment, verifyTotp, mfaStatus } = await import("@/application/mfa");
  const { changePassword } = await import("@/application/password-change");
  const { supabasePasswordVerifier } = await import("@/application/supabase-password-verifier");
  const { totp } = await import("./support/totp");
  const user = await provisionedUser("Native internal MFA");
  const proxy = await supabaseHttpGateway(inject("supabaseUrl"));
  try {
    const publicUrl = inject("supabaseUrl").replace("http:", "https:");
    const transport = createSupabaseTransport({ publicUrl, internalUrl: proxy.url });
    const cookies = cookieJar();
    const requestClient = () => asUserClient(createSessionClient(publicUrl, inject("supabaseAnonKey"), { cookies, fetch: transport }));
    const client = requestClient();
    expect(await logIn(client, { email: user.email, password: "correct-horse-battery" })).toEqual({ ok: true, value: null });
    const enrollment = await beginTotpEnrollment(client);
    if (!enrollment.ok) throw new Error(enrollment.error);
    expect((await completeTotpEnrollment(client, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) })).ok).toBe(true);
    expect((await mfaStatus(client)).currentLevel).toBe("aal2");
    expect(await changePassword(client, supabasePasswordVerifier(publicUrl, inject("supabaseAnonKey"), transport), {
      currentPassword: "correct-horse-battery", newPassword: "new-internal-password", confirmation: "new-internal-password",
    })).toEqual({ ok: true, value: null });
    expect(await logOut(client)).toEqual({ ok: true, value: null });
    const next = requestClient();
    expect(await logIn(next, { email: user.email, password: "new-internal-password" })).toEqual({ ok: true, value: null });
    expect((await mfaStatus(next)).currentLevel).toBe("aal1");
    const before = cookies.snapshot();
    proxy.unavailable(true);
    expect(await verifyTotp(requestClient(), { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) })).toEqual({ ok: false, error: "auth_unavailable" });
    expect(cookies.snapshot()).toEqual(before);
    proxy.unavailable(false);
    const restored = requestClient();
    expect(await verifyTotp(restored, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret, Date.now() + 30_000) })).toEqual({ ok: true, value: null });
    expect((await mfaStatus(restored)).currentLevel).toBe("aal2");
    const oauth = await restored.auth.signInWithOAuth({ provider: "google", options: { redirectTo: "https://app.example.test/auth/callback", skipBrowserRedirect: true } });
    expect(oauth.error).toBeNull();
    expect(oauth.data.url).toContain(`${publicUrl}/auth/v1/authorize?`);
    expect(oauth.data.url).not.toContain(proxy.url);
    expect(new URL(oauth.data.url!).searchParams.get("redirect_to")).toBe("https://app.example.test/auth/callback");
  } finally {
    proxy.close();
  }
});

it("preserves an expired cookie through failed native refresh and refreshes the same session after gateway recovery", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const user = await provisionedUser("Refresh outage");
  const proxy = await supabaseHttpGateway(inject("supabaseUrl"));
  try {
    const publicUrl = inject("supabaseUrl").replace("http:", "https:");
    const cookies = cookieJar();
    const transport = createSupabaseTransport({ publicUrl, internalUrl: proxy.url });
    const requestClient = () => asUserClient(createSessionClient(publicUrl, inject("supabaseAnonKey"), { cookies, fetch: transport }));
    expect((await logIn(requestClient(), { email: user.email, password: "correct-horse-battery" })).ok).toBe(true);
    const cookie = cookies.stored.get("sb-127-auth-token")!;
    const session = JSON.parse(Buffer.from(cookie.value.slice("base64-".length), "base64url").toString());
    const sessionId = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString()).session_id;
    session.expires_at = 1;
    cookies.setAll([{ name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`, options: cookie.options }]);
    const before = cookies.snapshot();
    proxy.unavailable(true);
    await expect(currentUserId(requestClient())).rejects.toThrow("auth_unavailable");
    expect(cookies.snapshot()).toEqual(before);
    proxy.unavailable(false);
    const restored = requestClient();
    expect(await currentUserId(restored)).toBe(user.userId);
    const refreshed = (await restored.auth.getSession()).data.session!;
    expect(refreshed.expires_at).toBeGreaterThan(Date.now() / 1_000);
    expect(JSON.parse(Buffer.from(refreshed.access_token.split(".")[1], "base64url").toString()).session_id).toBe(sessionId);
    expect(cookies.snapshot()).not.toEqual(before);
  } finally {
    proxy.close();
  }
}, 45_000);

it("preserves streamed Request semantics and init overrides at the real Auth HTTP boundary", async () => {
  const user = await provisionedUser("Stream request");
  const publicUrl = inject("supabaseUrl").replace("http:", "https:");
  const transport = createSupabaseTransport({ publicUrl, internalUrl: inject("supabaseUrl") });
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ email: user.email, password: "correct-horse-battery" })));
    controller.close();
  } });
  const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half", headers: { "content-type": "application/json" } };
  const request = new Request(`${publicUrl}/auth/v1/token?grant_type=password`, init);
  const response = await transport(request, { headers: { "content-type": "application/json", apikey: inject("supabaseAnonKey") } });
  expect(response.ok).toBe(true);
  expect((await response.json()).user.id).toBe(user.userId);
  await expect(transport(new URL(`${publicUrl}/auth/v1/settings`), { signal: AbortSignal.abort() })).rejects.toThrow();
});

it("signs and uploads through internal Storage while the generated public signed link remains usable", async () => {
  const url = new URL(inject("supabaseUrl"));
  url.hostname = "localhost";
  const publicUrl = url.origin;
  const proxy = await supabaseHttpGateway(inject("supabaseUrl"));
  const client = createClient(publicUrl, inject("supabaseSecretKey"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: createSupabaseTransport({ publicUrl, internalUrl: proxy.url }) },
  });
  const bucket = `transport-${crypto.randomUUID()}`;
  try {
    expect((await client.storage.createBucket(bucket)).error).toBeNull();
    expect((await client.storage.from(bucket).upload("example.txt", new TextEncoder().encode("public signed content"), { contentType: "text/plain" })).error).toBeNull();
    const signed = await client.storage.from(bucket).createSignedUrl("example.txt", 60);
    expect(signed.error).toBeNull();
    expect(signed.data!.signedUrl).toContain(`${publicUrl}/storage/v1/object/sign/`);
    expect(signed.data!.signedUrl).not.toContain(proxy.url);
    const response = await fetch(signed.data!.signedUrl);
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe("public signed content");
  } finally {
    await client.storage.emptyBucket(bucket);
    await client.storage.deleteBucket(bucket);
    proxy.close();
  }
});

it("logs in through internal Auth when the public server hostname does not resolve", async () => {
  const user = await provisionedUser("Public DNS failure");
  const publicUrl = "https://supabase-transport.invalid";
  await expect(fetch(`${publicUrl}/auth/v1/settings`)).rejects.toThrow();
  const client = asUserClient(createSessionClient(publicUrl, inject("supabaseAnonKey"), {
    cookies: cookieJar(), fetch: createSupabaseTransport({ publicUrl, internalUrl: inject("supabaseUrl") }),
  }));
  expect(await logIn(client, { email: user.email, password: "correct-horse-battery" })).toEqual({ ok: true, value: null });
  expect(await currentUserId(client)).toBe(user.userId);
  expect(await logOut(client)).toEqual({ ok: true, value: null });
});

it("commits a recovered native refresh and a subsequent successful logout after one retryable HTTP failure", async () => {
  const user = await provisionedUser("Refresh retry");
  const proxy = await supabaseHttpGateway(inject("supabaseUrl"));
  try {
    const cookies = cookieJar();
    const publicUrl = inject("supabaseUrl").replace("http:", "https:");
    const client = asUserClient(createSessionClient(publicUrl, inject("supabaseAnonKey"), {
      cookies, fetch: createSupabaseTransport({ publicUrl, internalUrl: proxy.url }),
    }));
    expect((await logIn(client, { email: user.email, password: "correct-horse-battery" })).ok).toBe(true);
    const before = cookies.snapshot();
    proxy.refuseNext(1);
    expect((await client.auth.refreshSession()).error).toBeNull();
    expect(cookies.snapshot()).not.toEqual(before);
    expect(await logOut(client)).toEqual({ ok: true, value: null });
    expect(cookies.getAll().map(cookie => cookie.name)).toEqual([]);
  } finally {
    proxy.close();
  }
});

it("reports temporary login unavailability if native sign-in succeeds but the authoritative access check is unavailable", async () => {
  const user = await provisionedUser("Access check outage");
  const proxy = await supabaseHttpGateway(inject("supabaseUrl"));
  try {
    const cookies = cookieJar();
    const publicUrl = inject("supabaseUrl").replace("http:", "https:");
    const requestClient = () => asUserClient(createSessionClient(publicUrl, inject("supabaseAnonKey"), {
      cookies, fetch: createSupabaseTransport({ publicUrl, internalUrl: proxy.url }),
    }));
    proxy.unavailable(true, "/rest/v1/");
    expect(await logIn(requestClient(), { email: user.email, password: "correct-horse-battery" })).toEqual({ ok: false, error: "login_unavailable" });
    expect(cookies.getAll().length).toBeGreaterThan(0);
    proxy.unavailable(false);
    expect(await currentUserId(requestClient())).toBe(user.userId);
    expect((await requestClient().rpc("current_user_can_use_application")).data).toBe(true);
  } finally {
    proxy.close();
  }
});
