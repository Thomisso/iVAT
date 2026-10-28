export const PROCESSING_JOB_RETRY_LIMIT = 3;
export const PROCESSING_JOB_RETRY_DELAY_SECONDS = 10;
export const PROCESSING_JOB_RETRY_DELAY_MAX_SECONDS = 300;

// pg-boss exponential delays before all configured attempts are exhausted.
export const PROCESSING_JOB_RETRY_WINDOW_MS = 1000 * Array.from(
  { length: PROCESSING_JOB_RETRY_LIMIT },
  (_, retry) => Math.min(
    PROCESSING_JOB_RETRY_DELAY_SECONDS * (2 ** retry),
    PROCESSING_JOB_RETRY_DELAY_MAX_SECONDS,
  ),
).reduce((total, delay) => total + delay, 0);

