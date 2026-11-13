/** Limits apply globally to generated/output tokens, including provider reasoning.
 * Input tokens are observed separately; this is never a total-token/spend cap. */
export type EvaluationLimits = {
  maxCalls: number;
  maxGeneratedTokens: number;
  generatedTokensPerAttempt: number;
  maxRetries: number;
};
export type EvaluationRunOptions = { limits: EvaluationLimits; repetitions: number; preflight?: boolean;
  tariffs?: import("./evaluation-prices").EvaluationTariff[] };
export type EvaluationBudgetState = {
  attemptedCalls: number; reservedGeneratedTokens: number;
  observedInputTokens: number | null; observedGeneratedTokens: number | null; observedTotalTokens: number | null; meteredAttempts: number; unmeteredAttempts: number;
  stopReason: "call_limit" | "generated_token_limit" | "usage_unavailable" | "usage_invalid" | null;
};

/** Reservations are never refunded: failed or unmetered requests may have
 * consumed the whole ceiling. Admission precedes every external attempt. */
export class EvaluationBudget {
  readonly state: EvaluationBudgetState = { attemptedCalls: 0, reservedGeneratedTokens: 0,
    observedInputTokens: null, observedGeneratedTokens: null, observedTotalTokens: null, meteredAttempts: 0, unmeteredAttempts: 0, stopReason: null };
  constructor(readonly limits: EvaluationLimits) {}
  admit() {
    if (this.state.stopReason) return false;
    if (this.state.attemptedCalls >= this.limits.maxCalls) this.state.stopReason = "call_limit";
    else if (this.limits.generatedTokensPerAttempt > this.limits.maxGeneratedTokens - this.state.reservedGeneratedTokens) this.state.stopReason = "generated_token_limit";
    if (this.state.stopReason) return false;
    this.state.attemptedCalls++;
    this.state.reservedGeneratedTokens += this.limits.generatedTokensPerAttempt;
    return true;
  }
  observe(usage: unknown): { inputTokens: number; outputTokens: number; costUsd?: number } | null {
    if (usage == null) {
      this.state.unmeteredAttempts++;
      this.state.observedTotalTokens = null;
      this.state.stopReason = "usage_unavailable";
      return null;
    }
    const value = usage as Record<string, unknown>;
    if (typeof usage !== "object" || !Number.isSafeInteger(value.inputTokens) || !Number.isSafeInteger(value.outputTokens)
      || (value.inputTokens as number) < 0 || (value.outputTokens as number) < 0
      || (value.outputTokens as number) > this.limits.generatedTokensPerAttempt
      || !Number.isSafeInteger((this.state.observedInputTokens ?? 0) + (value.inputTokens as number))
      || !Number.isSafeInteger((this.state.observedGeneratedTokens ?? 0) + (value.outputTokens as number))
      || !Number.isSafeInteger((this.state.observedInputTokens ?? 0) + (this.state.observedGeneratedTokens ?? 0) + (value.inputTokens as number) + (value.outputTokens as number))) {
      this.state.unmeteredAttempts++;
      this.state.observedTotalTokens = null;
      this.state.stopReason = "usage_invalid";
      return null;
    }
    this.state.meteredAttempts++;
    this.state.observedInputTokens = (this.state.observedInputTokens ?? 0) + (value.inputTokens as number);
    this.state.observedGeneratedTokens = (this.state.observedGeneratedTokens ?? 0) + (value.outputTokens as number);
    this.state.observedTotalTokens = this.state.unmeteredAttempts ? null : this.state.observedInputTokens + this.state.observedGeneratedTokens;
    return { inputTokens: value.inputTokens as number, outputTokens: value.outputTokens as number,
      ...(typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0 ? { costUsd: value.costUsd } : {}) };
  }
}

export function evaluationRunOptions(env: Record<string, string | undefined>, preflight: boolean): EvaluationRunOptions {
  const integer = (name: string, minimum: number, fallback?: string) => {
    const raw = env[name] ?? fallback;
    const value = Number(raw);
    if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) throw new Error("evaluation_limits_invalid");
    return value;
  };
  // A requested hard total-token limit cannot be implemented by silently
  // changing its unit to generated tokens.
  if (env.EVALUATION_MAX_TOKENS !== undefined || env.EVALUATION_MAX_TOTAL_TOKENS !== undefined || env.EVALUATION_MAX_COST_USD !== undefined) {
    throw new Error("evaluation_unsupported_hard_limit");
  }
  return { preflight, repetitions: integer("EVALUATION_REPETITIONS", 1, "1"), limits: {
    maxCalls: integer("EVALUATION_MAX_CALLS", 1),
    maxGeneratedTokens: integer("EVALUATION_MAX_GENERATED_TOKENS", 1),
    generatedTokensPerAttempt: integer("EVALUATION_GENERATED_TOKENS_PER_ATTEMPT", 16),
    maxRetries: integer("EVALUATION_MAX_RETRIES", 0),
  } };
}
