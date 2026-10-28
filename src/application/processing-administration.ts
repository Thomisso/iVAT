import type { AppClient, Result } from "./client";
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
  const { data, error } = await client.rpc("list_failed_processing_jobs");
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error) throw error;
  return { ok: true, value: data.map((job) => ({
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
