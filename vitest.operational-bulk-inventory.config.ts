import { defineConfig } from "vitest/config";
import diagnostic from "./vitest.operational-bulk-diagnostic.config";

// Dynamic collection expands parameterized cases without running tests/hooks or
// looking up a database. Runtime selection/limits come from the diagnostic config.
export default defineConfig({
  ...diagnostic,
  test: {
    ...diagnostic.test, globalSetup: [],
    provide: { supabaseUrl: "http://127.0.0.1:54321", databaseUrl: "postgresql://inventory@127.0.0.1:54322/postgres" },
  },
});
