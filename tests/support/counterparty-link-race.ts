import { Client } from "pg";
import { inject } from "vitest";

/** Place real public commands at the Company barrier after approval preparation. */
export async function directoryIdentityDuringApproval(
  companyId: string,
  approve: (holdAfterPreparation: () => Promise<void>) => Promise<unknown>,
  update: () => Promise<unknown>,
) {
  const barrier = new Client({ connectionString: inject("databaseUrl") });
  const observer = new Client({ connectionString: inject("databaseUrl") });
  await barrier.connect();
  await observer.connect();
  const pending: Promise<unknown>[] = [];
  async function waitForCompanyLock(command: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ waiting: boolean }>(
        "select exists (select 1 from pg_stat_activity where pid <> pg_backend_pid() and wait_event_type = 'Lock' and strpos(query, $1) > 0) as waiting", [command],
      );
      if (result.rows[0].waiting) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Public command did not reach Company barrier: ${command}`);
  }
  try {
    pending.push(approve(async () => {
      await barrier.query("begin");
      await barrier.query("select 1 from public.company where id = $1 for update", [companyId]);
    }));
    await waitForCompanyLock("save_and_approve_document");
    pending.push(update());
    await waitForCompanyLock("counterparty");
    await barrier.query("commit");
    return await Promise.allSettled(pending);
  } finally {
    await barrier.query("rollback");
    await Promise.allSettled(pending);
    await barrier.end();
    await observer.end();
  }
}

/** Exercise the deletion invariant before lifecycle grants/actions arrive in 233.
 * The temporary grant/policy and attempted DELETE are in one rolled-back
 * transaction; no other connection ever receives a new capability.
 */
export async function attemptHistoricalCounterpartyDelete(id: string, userId: string) {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query("begin");
    await database.query("grant delete on public.counterparty to authenticated");
    await database.query("create policy counterparty_history_probe_delete on public.counterparty for delete to authenticated using (private.can_access_company(company_id, organization_id))");
    await database.query("set local role authenticated");
    await database.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal1" })]);
    await database.query("delete from public.counterparty where id = $1", [id]);
    return { code: null };
  } catch (error) {
    return { code: (error as { code: string }).code };
  } finally {
    await database.query("rollback");
    await database.end();
  }
}
