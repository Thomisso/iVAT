"use server";

import { listCounterparties } from "@/application/counterparties";
import { requireUserClient } from "@/lib/supabase/server";

export async function searchDocumentCounterparties(companyId: string, search: string) {
  return listCounterparties(await requireUserClient(), companyId, { search, pageSize: 20 });
}
