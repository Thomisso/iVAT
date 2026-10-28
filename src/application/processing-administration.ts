import { isSuperAdmin } from "./platform-ai";
import type { AppClient, Result } from "./client";
import type { ProcessingJob } from "./processing";

export type FailedProcessingJob = {
  id: string;
  name: ProcessingJob["name"];
  targetId: string;
  failedAt: string;
  error: string;
};

/** Adapter seam for pg-boss. Application policy never reaches into its schema. */
export interface ProcessingJobAdministration {
  listFailed(): Promise<FailedProcessingJob[]>;
  getFailed(id: string): Promise<FailedProcessingJob | null>;
  retry(job: FailedProcessingJob): Promise<void>;
}

export async function listFailedProcessingJobs(
  client: AppClient,
  jobs: ProcessingJobAdministration,
): Promise<Result<FailedProcessingJob[], "forbidden">> {
  if (!(await isSuperAdmin(client))) return { ok: false, error: "forbidden" };
  return { ok: true, value: await jobs.listFailed() };
}

/** Resets the failed job's target before asking pg-boss to retry the same stored job. */
export async function retryFailedProcessingJob(
  client: AppClient,
  jobs: ProcessingJobAdministration,
  jobId: string,
): Promise<Result<null, "forbidden" | "not_retryable">> {
  if (!(await isSuperAdmin(client))) return { ok: false, error: "forbidden" };
  const job = await jobs.getFailed(jobId);
  if (!job) return { ok: false, error: "not_retryable" };
  const { error } = await client.rpc("prepare_processing_job_retry", {
    target_failed_job_id: job.id,
    target_job_name: job.name,
    target_id: job.targetId,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.hint === "not_retryable") return { ok: false, error: "not_retryable" };
    throw error;
  }
  await jobs.retry(job);
  return { ok: true, value: null };
}
