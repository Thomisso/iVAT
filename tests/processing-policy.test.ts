import { expect, it } from "vitest";
import {
  COMPANY_EXPORT_POLL_TIMEOUT_MS,
  PROCESSING_JOB_ATTEMPT_EXECUTION_MARGIN_MS,
  PROCESSING_JOB_QUEUE_OPTIONS,
  PROCESSING_JOB_WORST_CASE_RETRY_DELAYS_MS,
  PROCESSING_JOB_WORST_CASE_RETRY_WAIT_MS,
} from "@/lib/processing-policy";

it("keeps export polling alive through pg-boss's worst-case jittered retries and final execution", () => {
  expect(PROCESSING_JOB_QUEUE_OPTIONS).toEqual({
    retryLimit: 3,
    retryDelay: 10,
    retryBackoff: true,
    retryDelayMax: 300,
  });
  expect(PROCESSING_JOB_WORST_CASE_RETRY_DELAYS_MS).toEqual([
    20_000,
    40_000,
    80_000,
  ]);
  expect(PROCESSING_JOB_WORST_CASE_RETRY_WAIT_MS).toBe(140_000);
  expect(COMPANY_EXPORT_POLL_TIMEOUT_MS).toBe(
    PROCESSING_JOB_WORST_CASE_RETRY_WAIT_MS
      + (PROCESSING_JOB_QUEUE_OPTIONS.retryLimit + 1) * PROCESSING_JOB_ATTEMPT_EXECUTION_MARGIN_MS,
  );
  expect(COMPANY_EXPORT_POLL_TIMEOUT_MS).toBe(380_000);
});
