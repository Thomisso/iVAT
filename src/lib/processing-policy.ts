export const PROCESSING_JOB_QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 10,
  retryBackoff: true,
  retryDelayMax: 300,
} as const;

// pg-boss 12.38 adds uniform jitter from the nominal exponential delay up to
// twice that delay, capped by retryDelayMax. Use the upper bound because the UI
// must not give up while the queue can still start another configured attempt.
export const PROCESSING_JOB_WORST_CASE_RETRY_DELAYS_MS = Array.from(
  { length: PROCESSING_JOB_QUEUE_OPTIONS.retryLimit },
  (_, retry) => 1000 * Math.min(
    PROCESSING_JOB_QUEUE_OPTIONS.retryDelayMax,
    PROCESSING_JOB_QUEUE_OPTIONS.retryDelay * (2 ** (retry + 1)),
  ),
);

export const PROCESSING_JOB_WORST_CASE_RETRY_WAIT_MS =
  PROCESSING_JOB_WORST_CASE_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0);

// Each of the initial attempt plus three retries gets a minute to rebuild and
// hash the maximum supported archive. This is a safety margin, not a queue
// timeout; a terminal receipt still prevents deletion if processing exceeds it.
export const PROCESSING_JOB_ATTEMPT_EXECUTION_MARGIN_MS = 60_000;
export const COMPANY_EXPORT_POLL_TIMEOUT_MS = PROCESSING_JOB_WORST_CASE_RETRY_WAIT_MS
  + (PROCESSING_JOB_QUEUE_OPTIONS.retryLimit + 1) * PROCESSING_JOB_ATTEMPT_EXECUTION_MARGIN_MS;
