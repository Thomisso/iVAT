import { Client } from "pg";
import { inject } from "vitest";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Private external clock, restored exactly; no clock mutation is granted to callers. */
export async function withUploadClock<T>(instant: string, run: (set: (instant: string) => Promise<void>) => Promise<T>): Promise<T> {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  await database.query("select pg_advisory_lock(317, 7)");
  const definition = async () => (await database.query<{ definition: string }>(
    "select pg_get_functiondef('private.source_upload_now()'::regprocedure) as definition",
  )).rows[0].definition;
  const original = await definition();
  const marker = path.resolve(".supabase-worktree/upload-clock-restore.json");
  try {
    try {
      await readFile(marker);
      throw new Error("Interrupted upload clock fixture requires isolated DB restoration/reset");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, JSON.stringify({ original, resetRequiredIfInterrupted: true }), { flag: "wx", mode: 0o600 });
    const set = async (value: string) => {
      if (!/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid fixture instant");
      await database.query(`create or replace function private.source_upload_now() returns timestamptz language sql volatile set search_path='' as $$ select timestamptz '${value}' $$`);
      await database.query("revoke all on function private.source_upload_now() from public,anon,authenticated,service_role");
    };
    try { await set(instant); return await run(set); }
    finally {
      await database.query(original);
      if (await definition() !== original) throw new Error("Upload clock restoration failed; reset isolated DB");
      await unlink(marker);
    }
  } finally {
    await database.query("select pg_advisory_unlock(317, 7)");
    await database.end();
  }
}
