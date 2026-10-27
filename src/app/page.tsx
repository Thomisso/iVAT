import { redirect } from "next/navigation";
import { listMyCompanies } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";

// After login the user lands on their first Company, or creates one.
export default async function HomePage() {
  const [first] = await listMyCompanies(await requireUserClient());
  redirect(first ? `/companies/${first.id}` : "/companies/new");
}
