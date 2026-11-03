import "server-only";
import { supabaseUrl } from "@/lib/env";
import { createSupabaseTransport } from "./transport";

/** Shared server HTTP boundary for request clients and narrow Auth adapters. */
export const serverSupabaseFetch = createSupabaseTransport({
  publicUrl: supabaseUrl,
  internalUrl: process.env.SUPABASE_INTERNAL_URL,
});
