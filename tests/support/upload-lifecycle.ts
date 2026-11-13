import { Client } from "pg";
import { inject } from "vitest";

export async function legacyUploadLayoutFixture(sourceFileId: string) {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try { await database.query("update public.source_upload_transfer set legacy_layout=true where source_file_id=$1", [sourceFileId]); }
  finally { await database.end(); }
}

/** Pause a real Storage transaction AFTER INSERT/RLS, before it commits. An
 * empty cleanup snapshot therefore cannot yet see this admitted object's row. */
export async function delayedTemporaryWrite<T, R>(name: string, upload: () => Promise<T>, during: (finish: () => Promise<T>) => Promise<R>) {
  if (!/^[a-f0-9/-]+$/.test(name)) throw new Error("Invalid fixture object name");
  const barrier = new Client({ connectionString: inject("databaseUrl") });
  const observer = new Client({ connectionString: inject("databaseUrl") });
  await barrier.connect(); await observer.connect();
  let pending: Promise<T> | undefined;
  let released = false;
  const release = async () => {
    if (!released) { released = true; await barrier.query("select pg_advisory_unlock(317,9)"); }
  };
  try {
    await barrier.query("select pg_advisory_lock(317,9)");
    const pid = (await barrier.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0].pid;
    await barrier.query(`create function private.test_delay_upload_commit() returns trigger language plpgsql as $$
      begin if new.bucket_id='source-upload-chunks' and new.name='${name}' then perform pg_advisory_xact_lock(317,9); end if; return new; end $$;
      create trigger test_delay_upload_commit after insert on storage.objects for each row execute function private.test_delay_upload_commit()`);
    pending = upload();
    const deadline = Date.now() + 5_000;
    let blocked = false;
    while (Date.now() < deadline) {
      if ((await observer.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) blocked", [pid])).rows[0].blocked) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!blocked) throw new Error("Storage transaction did not reach AFTER INSERT commit barrier");
    return await during(async () => { await release(); return await pending!; });
  } finally {
    await release();
    await Promise.allSettled(pending ? [pending] : []);
    try { await barrier.query("drop trigger if exists test_delay_upload_commit on storage.objects; drop function if exists private.test_delay_upload_commit()"); }
    finally { await barrier.end(); await observer.end(); }
  }
}

/** Queue real public RPCs in a known order at the shared Company lock. */
export async function orderedUploadCommands(companyId: string, commands: { query: string; run: () => Promise<unknown> }[]) {
  const barrier = new Client({ connectionString: inject("databaseUrl") });
  const observer = new Client({ connectionString: inject("databaseUrl") });
  await barrier.connect(); await observer.connect();
  const pending: Promise<unknown>[] = [];
  try {
    await barrier.query("begin");
    await barrier.query("select 1 from public.company where id=$1 for update", [companyId]);
    for (const command of commands) {
      pending.push(command.run());
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        if ((await observer.query<{ waiting: boolean }>("select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and strpos(query,$1)>0) waiting", [command.query])).rows[0].waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!waiting) throw new Error(`Upload RPC did not reach the Company barrier: ${command.query}`);
    }
    await barrier.query("commit");
    return await Promise.allSettled(pending);
  } finally {
    await barrier.query("rollback");
    await Promise.allSettled(pending);
    await barrier.end(); await observer.end();
  }
}
