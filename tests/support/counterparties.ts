import { Client } from "pg";
import { inject } from "vitest";

/** Historical archive fixture; lifecycle commands belong to the follow-up ticket. */
export async function archiveCounterpartyFixture(id: string, userId: string) {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query("begin");
    await database.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal1" })]);
    await database.query("update public.counterparty set archived_at = '2026-11-01T00:00:00Z' where id = $1", [id]);
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

/** Queue real authenticated commands at the Company's existing deletion lock. */
export async function directoryMutationAfterCompanyDeletion(
  companyId: string,
  removeCompany: () => Promise<unknown>,
  mutateDirectory: () => Promise<unknown>,
) {
  const barrier = new Client({ connectionString: inject("databaseUrl") });
  const observer = new Client({ connectionString: inject("databaseUrl") });
  await barrier.connect();
  await observer.connect();
  const pending: Promise<unknown>[] = [];
  async function blocked(command: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ waiting: boolean }>(
        "select exists (select 1 from pg_stat_activity where pid <> pg_backend_pid() and wait_event_type = 'Lock' and strpos(query, $1) > 0) as waiting",
        [command],
      );
      if (result.rows[0].waiting) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Directory race command did not reach the Company lock: ${command}`);
  }
  try {
    await barrier.query("begin");
    await barrier.query("select 1 from public.company where id = $1 for update", [companyId]);
    pending.push(removeCompany());
    await blocked("soft_delete_company");
    pending.push(mutateDirectory());
    await blocked("counterparty");
    await barrier.query("commit");
    return await Promise.allSettled(pending);
  } finally {
    await barrier.query("rollback");
    await Promise.allSettled(pending);
    await barrier.end();
    await observer.end();
  }
}
