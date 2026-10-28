import { execSync } from "node:child_process";
import path from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    supabaseUrl: string;
    supabaseAnonKey: string;
    supabaseSecretKey: string;
    supabaseJwtSecret: string;
  }
}

// Application-layer tests run against the local Supabase stack (ADR-0002).
// Its URL and keys are read from the running CLI instance.
const databaseFreeTests = new Set([
  path.resolve("tests/visual-prototype.test.ts"),
]);

export default function setup(project: TestProject) {
  // Vitest does not expose CLI file filters on TestProject during global setup.
  // When every explicitly requested test is pure UI, do not require Supabase.
  const requestedTests = process.argv.slice(2).filter((argument) => /\.test\.[cm]?[jt]sx?$/.test(argument));
  if (requestedTests.length > 0 && requestedTests.every((file) => databaseFreeTests.has(path.resolve(file)))) {
    return;
  }

  let status: Record<string, string>;
  try {
    status = JSON.parse(
      execSync("node scripts/supabase.mjs status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString(),
    );
  } catch {
    throw new Error("Local Supabase is not running. Start it with `npm run db:start`.");
  }
  project.provide("supabaseUrl", status.API_URL);
  project.provide("supabaseAnonKey", status.PUBLISHABLE_KEY);
  project.provide("supabaseSecretKey", status.SECRET_KEY);
  project.provide("supabaseJwtSecret", status.JWT_SECRET);
}
