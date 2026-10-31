import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/** Fixture setup records a Split against the actual current worker request. */
export async function sourceSplitRequestFixture(system: SupabaseClient<Database>, sourceFileId: string) {
  const source = await system.from("source_file").select("split_request_id").eq("id", sourceFileId).single();
  if (source.error) throw source.error;
  return source.data.split_request_id;
}
