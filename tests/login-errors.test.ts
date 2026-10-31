import { createClient } from "@supabase/supabase-js";
import { afterEach, expect, inject, it, vi } from "vitest";
import { logIn } from "@/application/auth";
import { asUserClient } from "@/application/client";
import { provisionedUser } from "./support/clients";

afterEach(() => vi.restoreAllMocks());

it("does not blame correct credentials for a TLS failure and permits the same credentials after recovery", async () => {
  const user = await provisionedUser("Login recovery");
  let unavailable = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  const transport: typeof fetch = (url, options) => {
    if (unavailable) {
      return Promise.reject(new TypeError("fetch failed", {
        cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      }));
    }
    return fetch(url, options);
  };
  const client = asUserClient(createClient(inject("supabaseUrl"), inject("supabaseAnonKey"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: transport },
  }));
  const credentials = { email: user.email, password: "correct-horse-battery" };
  expect(await logIn(client, credentials)).toEqual({ ok: false, error: "login_unavailable" });
  expect((await client.auth.getSession()).data.session).toBeNull();
  unavailable = false;
  expect(await logIn(client, credentials)).toEqual({ ok: true, value: null });
});

it.each([
  [400, "invalid_credentials", "invalid_credentials"],
  [429, "over_request_rate_limit", "login_rate_limited"],
  [503, "unexpected_failure", "login_unavailable"],
  [400, "email_not_confirmed", "login_unavailable"],
])("classifies Auth HTTP %s (%s) without treating every failure as a bad password", async (status, code, expected) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const client = asUserClient(createClient(inject("supabaseUrl"), inject("supabaseAnonKey"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async () => Response.json({ error_code: code, msg: "Auth refusal" }, { status }) },
  }));
  expect(await logIn(client, { email: "user@example.test", password: "example-password" }))
    .toEqual({ ok: false, error: expected });
  if (code === "invalid_credentials") {
    expect(log).not.toHaveBeenCalled();
  } else {
    expect(log).toHaveBeenCalledExactlyOnceWith("[auth:login-failed]", {
      name: status === 503 ? "AuthRetryableFetchError" : "AuthApiError",
      code: status === 503 ? undefined : code,
      status,
    });
  }
});
