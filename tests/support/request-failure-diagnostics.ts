import { inject, vi } from "vitest";

type ReportTestPhase = "fixture" | "generation" | "readback_assertions";

type RequestObservation = {
  operation: string;
  method: string;
  status: number | null;
  headersMs: number;
};

/** Failure-only timings for static local PostgREST operations; never capture request data. */
export async function withSupabaseRequestDiagnostics(
  run: (setPhase: (phase: ReportTestPhase) => void) => Promise<void>,
) {
  let phase: ReportTestPhase = "fixture";
  const origin = new URL(inject("supabaseUrl")).origin;
  const observations: RequestObservation[] = [];
  const transport = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    // SQL operation names only: exclude identifiers in paths, query values,
    // Auth, Storage and every external provider before recording anything.
    if (url.origin !== origin || !/^\/rest\/v1\/(?:rpc\/)?[a-z][a-z0-9_]{0,62}$/i.test(url.pathname)) {
      return transport(input, init);
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const started = performance.now();
    let status: number | null = null;
    try {
      const response = await transport(input, init);
      status = response.status;
      return response;
    } finally {
      observations.push({
        operation: url.pathname,
        method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method) ? method : "OTHER",
        status,
        // Stop at response headers, without consuming or changing the body.
        headersMs: Math.round((performance.now() - started) * 10) / 10,
      });
      if (observations.length > 32) observations.shift();
    }
  });
  try {
    await run((next) => { phase = next; });
  } catch (error) {
    console.error(`Supabase request failure diagnostics (phase: ${phase}; last 32 operations; headersMs):`, JSON.stringify(observations));
    throw error;
  } finally {
    spy.mockRestore();
  }
}
