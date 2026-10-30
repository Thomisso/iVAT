import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import type { Database } from "@/lib/database.types";
import type { JobWithMetadata } from "pg-boss";
import { asSystemClient } from "@/application/client";
import { PROCESSING_JOB_NAMES, runJob, type ProcessingJob, type Worker } from "@/application/processing";
import { configuredAiProviders } from "@/ai";
import { createBoss, createProcessingQueues, pgBossJobQueue } from "@/lib/jobs";
import { configuredVatPayerRegistry } from "@/vat-registry";
import { configuredExchangeRates } from "@/cnb";

// Background job runner (ADR-0002). The handlers live in the application layer
// so tests can run them directly; here they run against pg-boss, acting as the
// worker's service_role identity.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return value;
}

const boss = createBoss({ supervise: true });
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

async function heartbeat() {
  const path = process.env.WORKER_HEALTH_FILE;
  if (!path) return;
  if (!(await boss.getQueue(PROCESSING_JOB_NAMES[0]))) throw new Error("Processing queue is unavailable");
  writeFileSync(path, String(Date.now()), { mode: 0o600 });
}

const system = asSystemClient(
  createClient<Database>(process.env.SUPABASE_INTERNAL_URL ?? required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  }),
);

const providers = configuredAiProviders();
const worker: Worker = {
  system,
  providers: { get: (name) => providers.find((provider) => provider.name === name) },
  jobs: pgBossJobQueue(boss),
  vatRegistry: configuredVatPayerRegistry(),
  exchangeRates: configuredExchangeRates(),
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
  await heartbeat();
  if (process.env.WORKER_HEALTH_FILE) {
    heartbeatTimer = setInterval(() => {
      void heartbeat().catch(() => console.error("[worker] heartbeat failed"));
    }, 30_000);
    heartbeatTimer.unref();
  }
  console.log(`[worker] started with AI providers ${providers.map((provider) => provider.name).join(", ")}; VAT registry ${process.env.VAT_REGISTRY_PROVIDER ?? "adis"}; exchange rates ${process.env.EXCHANGE_RATE_PROVIDER ?? "cnb"}; waiting for jobs`);
}

async function shutdown() {
  clearInterval(heartbeatTimer);
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
