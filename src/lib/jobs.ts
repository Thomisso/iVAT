import { PgBoss } from "pg-boss";
import { PROCESSING_JOB_NAMES, type JobQueue } from "@/application/processing";
import {
  PROCESSING_JOB_RETRY_DELAY_MAX_SECONDS,
  PROCESSING_JOB_RETRY_DELAY_SECONDS,
  PROCESSING_JOB_RETRY_LIMIT,
} from "@/lib/processing-policy";

// Transient provider errors are retried with backoff; when the retries run out,
// the job's last attempt marks its Source File or Document Failed.
const QUEUE_OPTIONS = {
  retryLimit: PROCESSING_JOB_RETRY_LIMIT,
  retryDelay: PROCESSING_JOB_RETRY_DELAY_SECONDS,
  retryBackoff: true,
  retryDelayMax: PROCESSING_JOB_RETRY_DELAY_MAX_SECONDS,
};

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
    async send(job, options) {
      await boss.send(job.name, job.data, options?.startAfterSeconds === undefined
        ? undefined
        : { startAfter: options.startAfterSeconds });
    },
  };
}

let sender: Promise<JobQueue> | undefined;

/** The web app's queue: it only sends jobs; the worker process runs them. */
export const jobQueue: JobQueue = {
  async send(job, options) {
    sender ??= (async () => {
      const boss = createBoss({ supervise: false });
      await boss.start();
      await createProcessingQueues(boss);
      return pgBossJobQueue(boss);
    })();
    await (await sender).send(job, options);
  },
};
