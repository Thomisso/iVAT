import { isUuid, type AppClient, type Result } from "./client";
import type { ProcessingJob } from "./processing";

export type FailedProcessingJob = {
  id: string;
  name: ProcessingJob["name"];
  targetId: string;
  failedAt: string;
  error: string;
};

export async function listFailedProcessingJobs(
  client: AppClient,
): Promise<Result<FailedProcessingJob[], "forbidden">> {
  const { data, error } = await client.rpc("list_failed_processing_jobs_complete");
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error) throw error;
  const jobs = data as unknown as { id: string; name: string; target_id: string; failed_at: string; error: string }[];
  return { ok: true, value: jobs.map((job) => ({
    id: job.id,
    name: job.name as ProcessingJob["name"],
    targetId: job.target_id,
    failedAt: job.failed_at,
    error: job.error,
  })) };
}

/** Resets the failed job's target before asking pg-boss to retry the same stored job. */
export async function retryFailedProcessingJob(
  client: AppClient,
  jobId: string,
): Promise<Result<null, "forbidden" | "not_retryable">> {
  const { error } = await client.rpc("retry_failed_processing_job", {
    target_failed_job_id: jobId,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.hint === "not_retryable") return { ok: false, error: "not_retryable" };
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
