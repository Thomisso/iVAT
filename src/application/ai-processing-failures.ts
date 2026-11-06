import {
  AiProviderError,
  providerResponseOf,
  type AiProvider,
  type AiProviderConfiguration,
} from "./ai-provider";
import type { SystemClient } from "./client";
import type { Attempt } from "./processing";

type ProcessingTarget = { kind: "source_file" | "document"; id: string; requestId: string };

export type AiProcessingProviderContext = {
  provider: AiProvider | null;
  configuration: AiProviderConfiguration | null;
  configurationId: string | null;
};

type FailureDecision = "retry" | "waiting_for_platform" | "terminal";

function failureDecision(error: unknown, attempt: Attempt): FailureDecision {
  if (error instanceof AiProviderError && error.platformIntervention) return "waiting_for_platform";
  return attempt.final || (error instanceof AiProviderError && !error.transient) ? "terminal" : "retry";
}

/**
 * The common Split/Extraction failure policy. A platform wait finishes the
 * queue attempt without dispatching follow-up work; technical failures retain
 * the original error for the queue's retry policy. Target transitions remain
 * generation-bound in the handler and the recording RPCs (ADR-0010/0011).
 */
export async function runAiProcessingAttempt(
  system: SystemClient,
  context: {
    target: ProcessingTarget;
    attempt: Attempt;
    availability: () => AiProcessingProviderContext | undefined;
    markFailed: () => Promise<void>;
  },
  work: () => Promise<void>,
): Promise<boolean> {
  const { target, attempt } = context;
  try {
    // A failed status transition uses the same diagnostic boundary as work.
    try {
      await work();
    } catch (error) {
      if (failureDecision(error, attempt) === "terminal") await context.markFailed();
      throw error;
    }
    return true;
  } catch (error) {
    const availability = context.availability();
    await recordFailedAiResponse(system, target, error, availability);
    const decision = failureDecision(error, attempt);
    if (decision !== "retry") {
      const issue = error instanceof AiProviderError ? error : new AiProviderError(
        "processing_failed",
        target.kind === "source_file" ? "Source File processing failed" : "Document processing failed",
        { transient: false, classification: "processing_failed" },
      );
      await recordProcessingIssue(system, target, issue, availability, decision);
    }
    if (decision === "waiting_for_platform") return false;
    throw error;
  }
}

async function recordProcessingIssue(
  system: SystemClient,
  target: ProcessingTarget,
  error: AiProviderError,
  availability: AiProcessingProviderContext | undefined,
  state: "waiting_for_platform" | "terminal",
) {
  const recorded = await system.rpc("record_ai_processing_issue", {
    target_split_request_id: target.kind === "source_file" ? target.requestId : undefined,
    target_kind: target.kind,
    target_id: target.id,
    target_extraction_request_id: target.kind === "document" ? target.requestId : undefined,
    target_classification: error.classification,
    target_state: state,
    target_configuration_id: availability?.configurationId ?? error.configurationId ?? undefined,
    target_provider: availability?.provider?.name ?? error.provider ?? undefined,
  });
  if (recorded.error) throw recorded.error;
}

/** Best effort: a diagnostic storage problem never replaces the AI failure. */
async function recordFailedAiResponse(
  system: SystemClient,
  target: ProcessingTarget,
  error: unknown,
  availability: AiProcessingProviderContext | undefined,
) {
  const response = providerResponseOf(error);
  const provider = availability?.provider?.name ?? (error instanceof AiProviderError ? error.provider : null);
  if (response === null || !provider) return;
  const configuration = availability?.configuration;
  try {
    const { error: recordError } = await system.rpc("record_ai_failed_response", {
      target_kind: target.kind,
      target_id: target.id,
      target_request_id: target.requestId,
      target_provider: provider,
      target_model: (target.kind === "source_file" ? configuration?.splitModel : configuration?.extractModel) ?? undefined,
      target_error: error instanceof Error ? error.message : String(error),
      target_response: response,
    });
    if (recordError) throw recordError;
  } catch (recordError) {
    console.error(`[worker] could not record the failed AI response of ${target.kind} ${target.id}`, recordError);
  }
}
