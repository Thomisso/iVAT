import { inject } from "vitest";
import { Client as DatabaseClient } from "pg";
import { createManualDocument } from "@/application/documents";
import { ordinaryDomesticClaim } from "@/application/claim-eligibility";

/** Explicit human eligibility assumption for fixtures testing other accounting behavior. */
export function createConfirmedManualDocument(...args: Parameters<typeof createManualDocument>) {
  const [client, input, exchangeRates, registry] = args;
  return createManualDocument(client, { ...input, payload: ordinaryDomesticClaim(input.payload) && input.payload.taxPointDate ? { ...input.payload,
    claimEligibility: { period: input.payload.taxPointDate!.slice(0, 7), origin: "user", confirmed: true },
  } : input.payload }, exchangeRates, registry);
}

/** Real import evidence for fixtures whose October Extraction is meant to be current-period. */
export async function setOctoberImportFixture(sourceFileId: string) {
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  try { await database.query("update public.source_file set uploaded_at = '2026-10-10T10:00:00Z' where id = $1", [sourceFileId]); }
  finally { await database.end(); }
}
