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

/** Queue two real public commands at the existing Company serialization point. */
export async function orderedDirectoryLinkRace(
  companyId: string,
  first: { query: string; run: () => Promise<unknown> },
  second: { query: string; run: () => Promise<unknown> },
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
        "select exists (select 1 from pg_stat_activity where pid <> pg_backend_pid() and wait_event_type = 'Lock' and strpos(query, $1) > 0) as waiting", [command],
      );
      if (result.rows[0].waiting) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Public command did not reach the directory/link barrier: ${command}`);
  }
  try {
    await barrier.query("begin");
    await barrier.query("select 1 from public.company where id = $1 for update", [companyId]);
    pending.push(first.run());
    await blocked(first.query);
    pending.push(second.run());
    await blocked(second.query);
    await barrier.query("commit");
    return await Promise.allSettled(pending);
  } finally {
    await barrier.query("rollback");
    await Promise.allSettled(pending);
    await barrier.end();
    await observer.end();
  }
}
