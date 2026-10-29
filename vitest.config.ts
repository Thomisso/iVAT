import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/support/global-setup.ts"],
    // Database tests share one local Supabase stack, including mutable
    // platform-wide settings. Running files concurrently makes those settings
    // race and overloads the database's statement timeout in large fixtures.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
