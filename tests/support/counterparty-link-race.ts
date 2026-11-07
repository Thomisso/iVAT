import { Client } from "pg";
import { inject } from "vitest";

type CompanyBarrier = {
  hold: () => Promise<void>;
  queue: (command: () => Promise<unknown>, query: string) => Promise<void>;
};

async function withCompanyBarrier(companyId: string, arrange: (barrier: CompanyBarrier) => Promise<void>) {
  const barrier = new Client({ connectionString: inject("databaseUrl") });
  const observer = new Client({ connectionString: inject("databaseUrl") });
  await barrier.connect();
  await observer.connect();
  const pending: Promise<unknown>[] = [];
  try {
    await arrange({
      async hold() {
        await barrier.query("begin");
        await barrier.query("select 1 from public.company where id = $1 for update", [companyId]);
      },
      async queue(command, query) {
        pending.push(command());
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const result = await observer.query<{ waiting: boolean }>(
            "select exists (select 1 from pg_stat_activity where pid <> pg_backend_pid() and wait_event_type = 'Lock' and strpos(query, $1) > 0) as waiting", [query],
          );
          if (result.rows[0].waiting) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error(`Public command did not reach the Company barrier: ${query}`);
      },
    });
    await barrier.query("commit");
    return await Promise.allSettled(pending);
  } finally {
    await barrier.query("rollback");
    await Promise.allSettled(pending);
    await barrier.end();
    await observer.end();
  }
}

/** Place real public commands at the Company barrier after approval preparation. */
export async function directoryIdentityDuringApproval(
  companyId: string,
  approve: (holdAfterPreparation: () => Promise<void>) => Promise<unknown>,
  update: () => Promise<unknown>,
) {
  return withCompanyBarrier(companyId, async barrier => {
    await barrier.queue(() => approve(barrier.hold), "save_and_approve_document");
    await barrier.queue(update, "counterparty");
  });
}

/** Queue two real public commands at the existing Company serialization point. */
export async function orderedDirectoryLinkRace(
  companyId: string,
  first: { query: string; run: () => Promise<unknown> },
  second: { query: string; run: () => Promise<unknown> },
) {
  return withCompanyBarrier(companyId, async barrier => {
    await barrier.hold();
    await barrier.queue(first.run, first.query);
    await barrier.queue(second.run, second.query);
  });
}
