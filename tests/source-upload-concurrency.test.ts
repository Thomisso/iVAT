import { setTimeout as delay } from "node:timers/promises";
import { Client as DatabaseClient } from "pg";
import { expect, inject, it } from "vitest";
import { beginUploadBatch } from "@/application/upload-batches";
import { getSourceFile, listSourceFiles, uploadSourceFile } from "@/application/source-files";
import { administratorWithCompany } from "./support/fixtures";
import { selectFixtureFiles } from "./support/files";
import { testWorker } from "./support/worker";

it("uploads the next Source File while the worker moves its Batch sibling without a deadlock", async () => {
  const owner = await administratorWithCompany();
  const worker = testWorker();
  const { files, selectedFiles } = selectFixtureFiles("receipt.png", "two-invoices.pdf");
  const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 2, selectedFiles });
  if (!batch.ok) throw new Error(batch.error);
  const input = (index: number) => ({ companyId: owner.companyId, batchId: batch.value.id, ...files[index] });
  expect((await uploadSourceFile(owner.client, worker.jobs, input(0))).ok).toBe(true);
  const barrier = new DatabaseClient({ connectionString: inject("databaseUrl") });
  const observer = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await barrier.connect();
  await observer.connect();
  let pending: Promise<unknown> | undefined;
  try {
    // Pause the worker after its real first lock, before its status transition.
    await barrier.query("begin");
    await barrier.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
    await barrier.query("select id from public.company where id = $1 for update", [owner.companyId]);
    const pid = await barrier.query<{ pid: number }>("select pg_backend_pid() as pid");
    const source = await barrier.query<{ split_request_id: string }>("select split_request_id from public.source_file where id = $1", [selectedFiles[0].id]);
    pending = uploadSourceFile(owner.client, worker.jobs, input(1));
    // Handle either outcome immediately, including when the old code deadlocks.
    const uploaded = pending.then(value => ({ value }), error => ({ error }));
    let blocked = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ blocked: boolean }>(
        "select exists (select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid)) and query like '%source_file%') as blocked",
        [pid.rows[0].pid],
      );
      if (result.rows[0].blocked) { blocked = true; break; }
      await delay(10);
    }
    expect(blocked).toBe(true);
    const moved = await barrier.query<{ moved: boolean }>(
      "select public.move_source_processing_status($1, $2, 'processing', array['uploaded']::public.source_file_status[]) as moved",
      [selectedFiles[0].id, source.rows[0].split_request_id],
    );
    expect(moved.rows[0].moved).toBe(true);
    await barrier.query("commit");
    expect(await uploaded).toEqual({ value: { ok: true, value: { id: selectedFiles[1].id } } });
    expect(await listSourceFiles(owner.client, owner.companyId)).toHaveLength(2);
    expect((await getSourceFile(owner.client, owner.companyId, selectedFiles[0].id))?.status).toBe("processing");
  } finally {
    await barrier.query("rollback");
    await Promise.allSettled([pending].filter(value => value !== undefined));
    await barrier.end();
    await observer.end();
  }
});
