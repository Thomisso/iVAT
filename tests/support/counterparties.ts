import { Client } from "pg";
import { inject } from "vitest";

/** Historical archive fixture; lifecycle commands belong to the follow-up ticket. */
export async function archiveCounterpartyFixture(id: string) {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query("update public.counterparty set archived_at = '2026-11-01T00:00:00Z' where id = $1", [id]);
  } finally {
    await database.end();
  }
}
