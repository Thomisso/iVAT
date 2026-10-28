import { PgBoss, type JobWithMetadata } from "pg-boss";
import {
  type FailedProcessingJob,
  type ProcessingJobAdministration,
} from "@/application/processing-administration";
import { PROCESSING_JOB_NAMES, type JobQueue, type ProcessingJob } from "@/application/processing";

// Transient provider errors are retried with backoff; when the retries run out,
// the job's last attempt marks its Source File or Document Failed.
const QUEUE_OPTIONS = { retryLimit: 3, retryDelay: 10, retryBackoff: true, retryDelayMax: 300 };

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing environment variable DATABASE_URL. See .env.example.");
  return url;
}

/** Creates the processing queues if they don't exist yet. Both the web app and the worker call it. */
export async function createProcessingQueues(boss: PgBoss): Promise<void> {
  for (const name of PROCESSING_JOB_NAMES) await boss.createQueue(name, QUEUE_OPTIONS);
}

export function createBoss(options: { supervise: boolean }): PgBoss {
  const boss = new PgBoss({ connectionString: databaseUrl(), supervise: options.supervise, schedule: options.supervise });
  boss.on("error", (error) => console.error("[jobs]", error));
  return boss;
}

export function pgBossJobQueue(boss: PgBoss): JobQueue {
  return {
    async send(job) {
      await boss.send(job.name, job.data);
    },
  };
}

function failedProcessingJob(
  job: JobWithMetadata<ProcessingJob["data"]>,
): FailedProcessingJob | null {
  if (job.state !== "failed") return null;
  const targetId = job.name === "split-source-file"
    ? (job.data as { sourceFileId?: unknown }).sourceFileId
    : (job.data as { documentId?: unknown }).documentId;
  if (typeof targetId !== "string") return null;
  const output = job.output as { message?: unknown } | null;
  const message = output && typeof output.message === "string"
    ? output.message
    : output ? JSON.stringify(output) : "";
  return {
    id: job.id,
    name: job.name as ProcessingJob["name"],
    targetId,
    failedAt: (job.completedOn ?? job.startedOn ?? job.createdOn).toISOString(),
    error: message,
  };
}

/** Reads and retries terminal processing failures without exposing pg-boss to the application. */
export function pgBossProcessingJobAdministration(boss: PgBoss): ProcessingJobAdministration {
  return {
    async listFailed() {
      const stored = (await Promise.all(PROCESSING_JOB_NAMES.map((name) => (
        boss.findJobs<ProcessingJob["data"]>(name, { limit: 100_000 })
      )))).flat();
      return stored
        .flatMap((job) => failedProcessingJob(job) ?? [])
        .sort((a, b) => b.failedAt.localeCompare(a.failedAt));
    },
    async getFailed(id) {
      for (const name of PROCESSING_JOB_NAMES) {
        const stored = await boss.getJobById<ProcessingJob["data"]>(name, id);
        if (stored) return failedProcessingJob(stored);
      }
      return null;
    },
    async retry(job) {
      await boss.retry(job.name, job.id);
    },
  };
}

let sender: Promise<JobQueue> | undefined;
let administrator: Promise<ProcessingJobAdministration> | undefined;

/** The web app's queue: it only sends jobs; the worker process runs them. */
export const jobQueue: JobQueue = {
  async send(job) {
    sender ??= (async () => {
      const boss = createBoss({ supervise: false });
      await boss.start();
      await createProcessingQueues(boss);
      return pgBossJobQueue(boss);
    })();
    await (await sender).send(job);
  },
};

/** Server-side pg-boss console adapter, initialized lazily after SuperAdmin authorization. */
export function processingJobAdministration(): Promise<ProcessingJobAdministration> {
  administrator ??= (async () => {
    const boss = createBoss({ supervise: false });
    await boss.start();
    await createProcessingQueues(boss);
    return pgBossProcessingJobAdministration(boss);
  })();
  return administrator;
}
