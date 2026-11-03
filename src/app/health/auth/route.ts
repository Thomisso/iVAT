import { authDependencyAvailable } from "@/auth/auth-dependency";
import { supabasePublishableKey, supabaseUrl } from "@/lib/env";
import { serverSupabaseFetch } from "@/lib/supabase/server-transport";

export async function GET() {
  const available = await authDependencyAvailable({
    url: supabaseUrl, publishableKey: supabasePublishableKey, fetch: serverSupabaseFetch,
  });
  return Response.json({ status: available ? "available" : "degraded" }, {
    status: available ? 200 : 503, headers: { "Cache-Control": "no-store" },
  });
}
