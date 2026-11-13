import { createClient } from "@supabase/supabase-js";
import { afterEach, expect, inject, it, vi } from "vitest";
import { withSupabaseRequestDiagnostics } from "./support/request-failure-diagnostics";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reports the failed RPC and SQLSTATE without changing the client's original error or exposing request/error data", async () => {
  const failure = { code: "57014", message: "canceling statement due to statement timeout",
    details: "private_context_canary", hint: "private_hint_canary" };
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(failure), {
    status: 500, headers: { "Content-Type": "application/json", "private_header_canary": "private_header_value_canary" },
  }));
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  const client = createClient(inject("supabaseUrl"), "private_key_canary", {
    global: { headers: { Authorization: "Bearer private_authorization_canary" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let clientError: unknown;
  let thrown: unknown;
  try {
    await withSupabaseRequestDiagnostics(async () => {
      const result = await client.rpc("record_split", { target_source_file_id: "private_argument_canary" });
      clientError = result.error;
      throw result.error;
    });
  } catch (error) { thrown = error; }
  expect(thrown).toBe(clientError);
  expect(clientError).toEqual(failure);
  const diagnostic = JSON.parse(output.mock.calls[0][1] as string);
  expect(diagnostic.failedRequest).toEqual({
    operation: "/rest/v1/rpc/record_split", method: "POST", status: 500,
    headersMs: expect.any(Number), phase: "fixture", sqlState: "57014", contextClass: "statement_timeout",
  });
  const printed = JSON.stringify(output.mock.calls);
  for (const canary of ["private_context_canary", "private_hint_canary", "private_header_canary",
    "private_header_value_canary", "private_key_canary", "private_authorization_canary", "private_argument_canary"]) {
    expect(printed).not.toContain(canary);
  }
});

it("keeps a successful Response intact and emits nothing", async () => {
  const response = new Response("private_success_body_canary", { status: 200 });
  vi.stubGlobal("fetch", async () => response);
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  await withSupabaseRequestDiagnostics(async () => {
    const actual = await fetch(new URL("/rest/v1/rpc/record_split", inject("supabaseUrl")));
    expect(actual).toBe(response);
    expect(await actual.text()).toBe("private_success_body_canary");
  });
  expect(output).not.toHaveBeenCalled();
});

it("excludes Auth, Storage, external providers, query values and invalid error codes from failed-request output", async () => {
  const body = { code: "private_code_canary", message: "private_message_canary", details: "private_detail_canary" };
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 503 }));
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  let original: unknown;
  let thrown: unknown;
  try {
    await withSupabaseRequestDiagnostics(async () => {
      for (const url of [new URL("/auth/v1/token", inject("supabaseUrl")),
        new URL("/storage/v1/object/private_path_canary", inject("supabaseUrl")),
        "https://private_provider_canary.example.test/rest/v1/rpc/extract"]) await fetch(url);
      const response = await fetch(new URL("/rest/v1/rpc/record_split?private_query_canary=1", inject("supabaseUrl")));
      original = await response.json();
      throw original;
    });
  } catch (error) { thrown = error; }
  expect(thrown).toBe(original);
  expect(original).toEqual(body);
  const diagnostic = JSON.parse(output.mock.calls[0][1] as string);
  expect(diagnostic.observations).toHaveLength(1);
  expect(diagnostic.failedRequest).toEqual(expect.objectContaining({ operation: "/rest/v1/rpc/record_split", sqlState: null, contextClass: "http_error" }));
  expect(JSON.stringify(output.mock.calls)).not.toMatch(/private_\w+_canary/);
});

it("retains the original failure phase after bounded cleanup history and restores the transport", async () => {
  const originalError = { code: "57014" };
  const transport = async (input: RequestInfo | URL) => new Response(JSON.stringify(
    String(input).includes("record_split") ? { code: "57014", message: "canceling statement due to statement timeout" } : null,
  ), { status: String(input).includes("record_split") ? 500 : 200 });
  vi.stubGlobal("fetch", transport);
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(withSupabaseRequestDiagnostics(async (setPhase) => {
    setPhase("bulk_split");
    await fetch(new URL("/rest/v1/rpc/record_split", inject("supabaseUrl")));
    setPhase("cleanup");
    for (let index = 0; index < 40; index++) await fetch(new URL("/rest/v1/rpc/cleanup", inject("supabaseUrl")));
    throw originalError;
  })).rejects.toBe(originalError);
  const diagnostic = JSON.parse(output.mock.calls[0][1] as string);
  expect(diagnostic.observations).toHaveLength(32);
  expect(diagnostic.failedRequest).toEqual(expect.objectContaining({ phase: "bulk_split", operation: "/rest/v1/rpc/record_split", sqlState: "57014" }));
  expect(globalThis.fetch).toBe(transport);
});
