import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["deploy/tests/global-setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 20_000,
  },
});
