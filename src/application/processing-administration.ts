import { isUuid, type AppClient, type Result } from "./client";
import type { ProcessingJob } from "./processing";

export type FailedProcessingJob = {
  id: string;
  name: ProcessingJob["name"];
  targetId: string;
  failedAt: string;
  retryCount: number;
  error: string;
};

export async function listFailedProcessingJobs(
  client: AppClient,
): Promise<Result<FailedProcessingJob[], "forbidden">> {
  const { data, error } = await client.rpc("list_failed_processing_jobs_complete");
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error) throw error;
  const jobs = data as unknown as { id: string; name: string; target_id: string; failed_at: string; retry_count: number; error: string }[];
  return { ok: true, value: jobs.map((job) => ({
    id: job.id,
    name: job.name as ProcessingJob["name"],
    targetId: job.target_id,
    failedAt: job.failed_at,
    retryCount: job.retry_count,
    error: job.error,
  })) };
}

/** The raw body an AI provider returned when the current Split or Extraction of a target failed. */
export type FailedAiResponse = {
  targetKind: "source_file" | "document";
  targetId: string;
  provider: string;
  model: string | null;
  error: string;
  response: string;
  recordedAt: string;
};

/** MFA-verified SuperAdmin only (ADR-0014): the bodies hold Document data. */
export async function listFailedAiResponses(
  client: AppClient,
): Promise<Result<FailedAiResponse[], "forbidden">> {
  const { data, error } = await client.rpc("list_ai_failed_responses");
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error) throw error;
  return { ok: true, value: data.map((row) => ({
    targetKind: row.target_kind,
    targetId: row.target_id,
    provider: row.provider,
    model: row.model,
    error: row.error,
    response: row.response,
    recordedAt: row.recorded_at,
  })) };
}

/** Retries current failed work as an MFA-verified SuperAdmin. A recorded Split resumes
 * dispatch to its existing Documents; pending AI targets get a new request generation. */
export async function retryFailedProcessingJob(
  client: AppClient,
  jobId: string,
): Promise<Result<null, "forbidden" | "not_retryable" | "period_locked">> {
  const { error } = await client.rpc("retry_failed_processing_job", {
    target_failed_job_id: jobId,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.hint === "not_retryable" || error.hint === "period_locked") return { ok: false, error: error.hint };
    throw error;
  }
  return { ok: true, value: null };
}

/**
 * MFA-verified SuperAdmin only. A current failed Split enters Source review (or
 * its existing Documents); Extraction enters Document review. History remains
 * failed. Refusals leave both target and active failure intact.
 */
export async function takeOverFailedProcessingJob(
  client: AppClient,
  jobId: string,
): Promise<Result<null, "forbidden" | "not_recoverable" | "period_locked" | "source_already_resolved">> {
  if (!isUuid(jobId)) return { ok: false, error: "not_recoverable" };
  const { error } = await client.rpc("take_over_failed_processing_job", { target_failed_job_id: jobId });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.hint === "not_recoverable" || error.hint === "period_locked" || error.hint === "source_already_resolved") {
      return { ok: false, error: error.hint };
    }
    throw error;
  }
  return { ok: true, value: null };
}

/** Stops intervention for one failed export queue attempt, retaining its failure. */
export async function closeFailedExportAttempt(
  client: AppClient,
  jobId: string,
  retryCount: number,
): Promise<Result<null, "forbidden" | "not_closable">> {
  if (!isUuid(jobId) || !Number.isInteger(retryCount) || retryCount < 0) return { ok: false, error: "not_closable" };
  const { error } = await client.rpc("close_failed_export_attempt", { target_failed_job_id: jobId, expected_retry_count: retryCount });
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error?.hint === "not_closable") return { ok: false, error: "not_closable" };
  if (error) throw error;
  return { ok: true, value: null };
}
