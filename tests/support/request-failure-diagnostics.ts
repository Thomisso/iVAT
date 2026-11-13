import { inject, vi } from "vitest";

type RequestTestPhase = "fixture" | "generation" | "readback_assertions" | "bulk_split" | "reconciliation" | "cleanup";
type ErrorContextClass = "statement_timeout" | "query_cancelled" | "lock_timeout" | "deadlock"
  | "postgres_error" | "postgrest_error" | "http_error" | "transport_error";

type RequestObservation = {
  operation: string;
  method: string;
  status: number | null;
  headersMs: number;
  phase: RequestTestPhase;
  sqlState: string | null;
  contextClass: ErrorContextClass | null;
};

/** PostgREST does not normally return PostgreSQL CONTEXT. Classify only known
 * codes/messages; never emit message, details, hint or any untrusted body field. */
async function failureContext(response: Response): Promise<Pick<RequestObservation, "sqlState" | "contextClass">> {
  const unavailable = { sqlState: null, contextClass: "http_error" as const };
  try {
    const payload: unknown = await response.clone().json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return unavailable;
    const error = payload as Record<string, unknown>;
    if (typeof error.code !== "string") return unavailable;
    if (!/^[0-9A-Z]{5}$/.test(error.code)) {
      return /^PGRST\d{3}$/.test(error.code) ? { sqlState: null, contextClass: "postgrest_error" } : unavailable;
    }
    const sqlState = error.code;
    let contextClass: ErrorContextClass = "postgres_error";
    if (sqlState === "57014") contextClass = error.message === "canceling statement due to statement timeout" ? "statement_timeout" : "query_cancelled";
    if (sqlState === "55P03" && error.message === "canceling statement due to lock timeout") contextClass = "lock_timeout";
    if (sqlState === "40P01") contextClass = "deadlock";
    return { sqlState, contextClass };
  } catch {
    // Inspection is best effort; the caller still receives its original Response.
    return unavailable;
  }
}

/** Failure-only diagnostics at the real test HTTP boundary. Successful bodies
 * are untouched; a failed body is read from a clone without changing the SDK's
 * original Response/error. No request or raw error data enters the output. */
export async function withSupabaseRequestDiagnostics(
  run: (setPhase: (phase: RequestTestPhase) => void) => Promise<void>,
) {
  let phase: RequestTestPhase = "fixture";
  const origin = new URL(inject("supabaseUrl")).origin;
  const observations: RequestObservation[] = [];
  let failedRequest: RequestObservation | null = null;
  const transport = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    let url: URL;
    try { url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); }
    catch { return transport(input, init); }
    // Static SQL operation names only: exclude query values, identifiers in
    // paths, Auth, Storage and every external provider before observing anything.
    if (url.origin !== origin || !/^\/rest\/v1\/(?:rpc\/)?[a-z][a-z0-9_]{0,62}$/i.test(url.pathname)) {
      return transport(input, init);
    }
    const requestPhase = phase;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const started = performance.now();
    let status: number | null = null;
    let headersMs: number | null = null;
    let context: Pick<RequestObservation, "sqlState" | "contextClass"> = { sqlState: null, contextClass: "transport_error" };
    try {
      const response = await transport(input, init);
      status = response.status;
      headersMs = Math.round((performance.now() - started) * 10) / 10;
      context = response.ok ? { sqlState: null, contextClass: null } : await failureContext(response);
      return response;
    } finally {
      const observation: RequestObservation = {
        operation: url.pathname,
        method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method) ? method : "OTHER",
        status,
        headersMs: headersMs ?? Math.round((performance.now() - started) * 10) / 10,
        phase: requestPhase,
        ...context,
      };
      observations.push(observation);
      if (observations.length > 32) observations.shift();
      // Retain the first failure even if later cleanup requests exceed the ring.
      if (status === null || status >= 400) failedRequest ??= observation;
    }
  });
  try {
    await run((next) => { phase = next; });
  } catch (error) {
    try {
      console.error(`Supabase request failure diagnostics (phase: ${phase}; last 32 operations; headersMs):`, JSON.stringify({ failedRequest, observations }));
    } catch { /* Diagnostics must never replace the original application error. */ }
    throw error;
  } finally {
    spy.mockRestore();
  }
}
