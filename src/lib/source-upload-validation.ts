import "server-only";
import { supabaseSourceUploadValidation } from "@/source-uploads/supabase-validation";
import { supabaseUrl } from "./env";
import { serverSupabaseFetch } from "./supabase/server-transport";

export function sourceUploadValidation() {
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) throw new Error("Missing server validation capability credential");
  return supabaseSourceUploadValidation({ url: supabaseUrl, secretKey, fetch: serverSupabaseFetch });
}
