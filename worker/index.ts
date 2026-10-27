import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { JobWithMetadata } from "pg-boss";
import { asSystemClient } from "@/application/client";
import { PROCESSING_JOB_NAMES, runJob, type ProcessingJob, type Worker } from "@/application/processing";
import { configuredAiProvider } from "@/ai";
import { createBoss, createProcessingQueues, pgBossJobQueue } from "@/lib/jobs";

// Background job runner (ADR-0002). The handlers live in the application layer
// so tests can run them directly; here they run against pg-boss, acting as the
// worker's service_role identity.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return value;
}

const boss = createBoss({ supervise: true });

const worker: Worker = {
  system: asSystemClient(
    createClient<Database>(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  ),
  ai: configuredAiProvider(),
  jobs: pgBossJobQueue(boss),
};

async function main() {
  await boss.start();
  await createProcessingQueues(boss);
  for (const name of PROCESSING_JOB_NAMES) {
    await boss.work(name, { includeMetadata: true }, async ([job]: JobWithMetadata<ProcessingJob["data"]>[]) => {
      const attempt = { final: job.retryCount >= job.retryLimit };
      await runJob(worker, { name, data: job.data } as ProcessingJob, attempt);
    });
  }
  console.log(`[worker] started with AI provider ${worker.ai.name}; waiting for jobs`);
}

async function shutdown() {
  console.log("[worker] stopping");
  await boss.stop({ graceful: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  console.error("[worker] failed to start", error);
  process.exit(1);
});
