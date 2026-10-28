import { createClient } from "@supabase/supabase-js";
import { inject } from "vitest";
import type { AiProvider } from "@/application/ai-provider";
import { asSystemClient, type SystemClient } from "@/application/client";
import { runJob, type JobQueue, type ProcessingJob } from "@/application/processing";
import { fakeAiProvider } from "@/ai/fake";
import type { VatPayerRegistry } from "@/application/vat-registry";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import type { ExchangeRateProvider } from "@/application/exchange-rates";
import { fakeExchangeRates } from "@/cnb/fake";

/** A client acting as the worker, as `worker/index.ts` creates it. */
export function systemClient(): SystemClient {
  return asSystemClient(
    createClient(inject("supabaseUrl"), inject("supabaseSecretKey"), {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  );
}

/**
 * A worker whose queue holds jobs until the test runs them. `runJobs` executes
 * them synchronously through the same handler the worker process uses, including
 * the jobs they enqueue, and collects the errors a job throws (the worker would
 * log them and let pg-boss retry).
 */
export function testWorker(
  aiOrProviders: AiProvider | AiProvider[] = fakeAiProvider(),
  vatRegistry: VatPayerRegistry = fakeVatPayerRegistry(),
  exchangeRates: ExchangeRateProvider = fakeExchangeRates(),
) {
  const providers = Array.isArray(aiOrProviders) ? aiOrProviders : [aiOrProviders];
  const ai = providers[0];
  const queued: ProcessingJob[] = [];
  const delayed: ProcessingJob[] = [];
  const jobs: JobQueue = {
    async send(job, options) {
      (options?.startAfterSeconds === undefined ? queued : delayed).push(job);
    },
  };
  const worker = {
    system: systemClient(),
    providers: { get: (name: string) => providers.find((provider) => provider.name === name) },
    jobs,
    vatRegistry,
    exchangeRates,
  };
  return {
    jobs,
    ai,
    queued,
    delayed,
    releaseDelayedJobs() {
      queued.push(...delayed.splice(0));
    },
    /** Runs just the next queued job, leaving follow-up jobs queued. */
    async runNextJob({ final = true } = {}): Promise<void> {
      const job = queued.shift();
      if (job) await runJob(worker, job, { final });
    },
    /** Runs every queued job; `final: false` runs them as attempts that pg-boss will retry. */
    async runJobs({ final = true } = {}): Promise<unknown[]> {
      const errors: unknown[] = [];
      while (queued.length > 0) {
        const job = queued.shift()!;
        try {
          await runJob(worker, job, { final });
        } catch (error) {
          errors.push(error);
        }
      }
      return errors;
    },
    /** Runs the jobs queued now all at once, as several worker processes would; then the rest in turn. */
    async runJobsConcurrently(): Promise<unknown[]> {
      const batch = queued.splice(0);
      const settled = await Promise.allSettled(batch.map((job) => runJob(worker, job, { final: true })));
      const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      return [...errors, ...(await this.runJobs())];
    },
  };
}
