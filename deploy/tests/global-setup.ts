import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { TestProject } from "vitest/node";
import { Client } from "pg";

// The Compose override publishes only loopback ports. Reuse the Application
// suite against the exact self-hosted services and migration history.
export default async function setup(project: TestProject) {
  const env = parseEnv(readFileSync(".env.rosti", "utf8"));
  function required(name: string): string {
    const value = env[name];
    if (!value) throw new Error(`Missing ${name} in .env.rosti`);
    return value;
  }
  project.provide("supabaseUrl", "http://127.0.0.1:3182");
  project.provide("supabaseAnonKey", required("ANON_KEY"));
  project.provide("supabaseSecretKey", required("SERVICE_ROLE_KEY"));
  project.provide("supabaseJwtSecret", required("JWT_SECRET"));
  const databaseUrl = `postgres://postgres:${required("POSTGRES_PASSWORD")}@127.0.0.1:3183/postgres`;
  project.provide("databaseUrl", databaseUrl);
  // Existing scenarios assume no platform default before they provision one.
  // Keep reruns deterministic without resetting tenant data or migration history.
  const database = new Client({ connectionString: databaseUrl });
  await database.connect();
  try {
    await database.query("update public.ai_configuration set is_default = false where is_default");
  } finally {
    await database.end();
  }
}
