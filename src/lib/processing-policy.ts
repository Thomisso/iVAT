export const PROCESSING_JOB_QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 10,
  retryBackoff: true,
  retryDelayMax: 300,
} as const;
