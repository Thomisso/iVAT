import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * A Supabase client acting as one user (or anonymously). Every application
 * command and query takes one, so Row-Level Security applies to everything
 * the application layer does.
 */
export type AppClient = SupabaseClient<Database>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether an id from a URL or form can name a row; anything else would make Postgres raise instead of match nothing. */
export const isUuid = (value: string) => UUID.test(value);

export type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };

/**
 * A Supabase client acting as the worker (service_role), which RLS does not
 * restrict. Only background job handlers take one; the database still limits it
 * to reading and to the processing transitions it grants the worker.
 */
export type SystemClient = SupabaseClient<Database>;
