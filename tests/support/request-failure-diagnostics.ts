import { inject, vi } from "vitest";
import type { RequestTestPhase } from "./operational-bulk-protocol";
export type { RequestTestPhase } from "./operational-bulk-protocol";
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
function errorContext(payload: unknown): Pick<RequestObservation, "sqlState" | "contextClass"> {
  const unavailable = { sqlState: null, contextClass: "http_error" as const };
  try {
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
    return unavailable;
  }
}

async function failureContext(response: Response) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) throw new Error("no diagnostic body");
    const decode = async () => {
      const decoder = new TextDecoder(); let bytes = 0, chunks = 0, text = "";
      while (true) {
        const part = await reader!.read();
        if (part.done) return JSON.parse(text + decoder.decode());
        bytes += part.value.byteLength;
        if (bytes > 65536 || ++chunks > 1024) throw new Error("diagnostic body limit");
        text += decoder.decode(part.value, { stream: true });
      }
    };
    const limit = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("diagnostic body deadline")), 100); });
    return errorContext(await Promise.race([decode(), limit]));
  } catch { return { sqlState: null, contextClass: "http_error" as const }; }
  finally {
    clearTimeout(timeout);
    // A tee cancellation can await its untouched sibling. Never await it.
    void reader?.cancel().catch(() => {});
  }
}

/** A test may retain this boundary through its afterEach hook. All failures are
 * observed without changing propagation, including direct-PG fixture failures.
 * This never records arguments, query values, headers or raw error fields. */
export function startSupabaseRequestDiagnostics(options: { reportOnSuccess?: boolean; announce?: boolean } = {}) {
  let phase: RequestTestPhase = "fixture";
  const started = performance.now();
  const origin = new URL(inject("supabaseUrl")).origin;
  const observations: RequestObservation[] = [];
  const phases: { phase: RequestTestPhase; elapsedMs: number }[] = [];
  const stageFailures: { phase: RequestTestPhase; sqlState: string | null; contextClass: ErrorContextClass | null }[] = [];
  let firstFailure: ({ kind: "request" } & RequestObservation) | ({ kind: "stage" } & typeof stageFailures[number]) | null = null;
  let failedRequest: RequestObservation | null = null;
  let finished = false;
  const setPhase = (next: RequestTestPhase) => {
    phase = next;
    phases.push({ phase, elapsedMs: Math.round((performance.now() - started) * 10) / 10 });
    if (phases.length > 64) phases.shift();
  };
  const announce = (state: "start" | "end") => {
    try { console.info(`Operational bulk request diagnostics: ${state}`, new Date().toISOString()); }
    catch { /* A failed log sink must not change the test's outcome. */ }
  };
  if (options.announce) announce("start");
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
      if (status === null || status >= 400) {
        failedRequest ??= observation;
        firstFailure ??= { kind: "request", ...observation };
      }
    }
  });
  const observedErrors = new WeakSet<object>();
  const observeFailure = (error: unknown, observedPhase = phase) => {
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      if (observedErrors.has(error)) return;
      observedErrors.add(error);
    }
    const context = errorContext(error);
    const failure = { phase: observedPhase, ...context, contextClass: context.sqlState === null ? null : context.contextClass };
    firstFailure ??= { kind: "stage", ...failure };
    stageFailures.push(failure);
    if (stageFailures.length > 16) stageFailures.shift();
  };
  return {
    firstFailure: () => firstFailure ? { ...firstFailure } : null,
    setPhase,
    observeFailure,
    async runPhase<T>(next: RequestTestPhase, run: () => Promise<T>): Promise<T> {
      setPhase(next);
      try { return await run(); }
      catch (error) {
        observeFailure(error, next);
        throw error;
      }
    },
    finish(failed = stageFailures.length > 0) {
      const report = { firstFailure, failedRequest, stageFailures, phases, observations };
      if (finished) return report;
      finished = true;
      spy.mockRestore();
      try {
        if (failed || options.reportOnSuccess) {
          const serialized = JSON.stringify(report);
          if (failed) console.error("Supabase request failure diagnostics (last 32 operations; headersMs):", serialized);
          else console.info("Supabase request measurement (last 32 operations; headersMs):", serialized);
        }
      } catch { /* Diagnostics must never replace an application error. */ }
      if (options.announce) announce("end");
      return report;
    },
  };
}

/** Failure-only wrapper for report cases whose cleanup remains inside run. */
export async function withSupabaseRequestDiagnostics(
  run: (setPhase: (phase: RequestTestPhase) => void) => Promise<void>,
) {
  const diagnostics = startSupabaseRequestDiagnostics();
  let failed = false;
  try {
    await run(diagnostics.setPhase);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    diagnostics.finish(failed);
  }
}
