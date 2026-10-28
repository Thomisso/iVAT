import "server-only";
import { createClient } from "@supabase/supabase-js";
import { asSystemClient, type SystemClient } from "@/application/client";
import type { Database } from "@/lib/database.types";
import { supabaseUrl } from "@/lib/env";

/** A server-only client for narrow RPCs that are explicitly granted to service_role. */
export function createSystemClient(): SystemClient {
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) throw new Error("Missing environment variable SUPABASE_SECRET_KEY. See .env.example.");
  return asSystemClient(createClient<Database>(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }));
}
