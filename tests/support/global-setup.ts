import { execSync } from "node:child_process";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    supabaseUrl: string;
    supabaseAnonKey: string;
  }
}

// Application-layer tests run against the local Supabase stack (ADR-0002).
// Its URL and keys are read from the running CLI instance.
export default function setup(project: TestProject) {
  let status: Record<string, string>;
  try {
    status = JSON.parse(
      execSync("npx supabase status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString(),
    );
  } catch {
    throw new Error("Local Supabase is not running. Start it with `npm run db:start`.");
  }
  project.provide("supabaseUrl", status.API_URL);
  project.provide("supabaseAnonKey", status.PUBLISHABLE_KEY);
}
