import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// Who a client acts as. The two client types carry different values, so the
// typechecker refuses a worker client where a user's is expected, and the reverse.
declare const actingAs: unique symbol;

/**
 * A Supabase client acting as one user (or anonymously). Every application
 * command and query takes one, so Row-Level Security applies to everything
 * the application layer does.
 */
export type AppClient = SupabaseClient<Database> & { readonly [actingAs]: "user" };

/** Marks a client created with the publishable key and a user's session (or none) as an AppClient. */
export const asUserClient = (client: SupabaseClient<Database>) => client as AppClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether an id from a URL or form can name a row; anything else would make Postgres raise instead of match nothing. */
export const isUuid = (value: string) => UUID.test(value);

export type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };

/**
 * A Supabase client acting as the worker (service_role), which RLS does not
 * restrict. Only background job handlers take one; the database still limits it
 * to reading and to the processing transitions it grants the worker.
 */
export type SystemClient = SupabaseClient<Database> & { readonly [actingAs]: "system" };

/** Marks a client created with the secret key as the SystemClient. Only the worker and its tests call this. */
export const asSystemClient = (client: SupabaseClient<Database>) => client as SystemClient;
