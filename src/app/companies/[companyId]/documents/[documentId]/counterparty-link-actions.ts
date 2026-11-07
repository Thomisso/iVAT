"use server";

import { listCounterparties } from "@/application/counterparties";
import { requireUserClient } from "@/lib/supabase/server";

export async function searchDocumentCounterparties(companyId: string, search: string, identifiers?: { ico?: string; vatId?: string }) {
  return listCounterparties(await requireUserClient(), companyId, { search, identifiers, pageSize: 20 });
}
