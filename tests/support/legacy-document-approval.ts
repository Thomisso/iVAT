import { Client as DatabaseClient } from "pg";

/** Represents predecessor data approved before complete-data guards existed. */
export async function setLegacyDocumentApprovedFixture(databaseUrl: string, documentId: string) {
  const database = new DatabaseClient({ connectionString: databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    // Session-local fixture setup; no application or other test connection can
    // bypass the guards. Only the historical status is changed.
    await database.query("set local session_replication_role = replica");
    await database.query("update public.document set status = 'approved' where id = $1", [documentId]);
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}
