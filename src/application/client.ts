import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * A Supabase client acting as one user (or anonymously). Every application
 * command and query takes one, so Row-Level Security applies to everything
 * the application layer does.
 */
export type AppClient = SupabaseClient<Database>;

export type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };
