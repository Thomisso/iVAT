import { execSync } from "node:child_process";
import path from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    supabaseUrl: string;
    supabaseAnonKey: string;
    supabaseSecretKey: string;
    supabaseJwtSecret: string;
    databaseUrl: string;
  }
}

// Application-layer tests run against the local Supabase stack (ADR-0002).
// Its URL and keys are read from the running CLI instance.
const databaseFreeTests = new Set([
  path.resolve("tests/visual-prototype.test.ts"),
]);

export function shouldSkipDatabaseSetup(argv: readonly string[]) {
  const scope = argv.slice(2);
  return scope.length === 2
    && scope[0] === "run"
    && databaseFreeTests.has(path.resolve(scope[1]));
}

export default function setup(project: TestProject) {
  // Vitest does not expose CLI file filters on TestProject during global setup.
  // Only the exact `vitest run <allowlisted-file>` shape is safe to exempt:
  // directories, mixed selectors and options all retain the database preflight.
  if (shouldSkipDatabaseSetup(process.argv)) {
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
  project.provide("databaseUrl", status.DB_URL);
}
