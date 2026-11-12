import { Client } from "pg";
import { inject } from "vitest";

/** Auth state not writable by an ordinary User, for revocation verification only. */
export async function alertAccountFixture(userId: string, state: "unverified" | "email_change") {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    if (state === "unverified") await database.query("update auth.users set email_confirmed_at = null where id = $1", [userId]);
    else await database.query("update auth.users set email_change = 'pending@example.test' where id = $1", [userId]);
  } finally { await database.end(); }
}

/** Uses the actual current generation, like a running processing handler. */
export async function documentAlertRequest(documentId: string) {
  const { systemClient } = await import("./worker");
  const result = await systemClient().from("document").select("extraction_request_id").eq("id", documentId).single();
  if (result.error) throw result.error;
  return result.data.extraction_request_id;
}
