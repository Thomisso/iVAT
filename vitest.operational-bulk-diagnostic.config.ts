import { defineConfig } from "vitest/config";
import application from "./vitest.config";

// Temporary exact-file diagnostic; never supplies complete application evidence.
// Replace include directly: mergeConfig concatenates arrays and would run others.
export default defineConfig({
  ...application,
  test: { ...application.test, include: ["tests/operational-email-alerts.test.ts"], maxWorkers: 1 },
});
