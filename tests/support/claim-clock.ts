import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

/** Isolated external-clock fixture. Never exposes a clock setter to app Users. */
export async function withClaimDate<T>(databaseUrl: string, date: string, run: (clock: { setDate: (date: string) => Promise<void> }) => Promise<T>): Promise<T> {
  const database = new Client({ connectionString: databaseUrl });
  await database.connect();
  await database.query("select pg_advisory_lock(238, 7)");
  const definition = async () => (await database.query<{ definition: string | null }>(
    "select pg_get_functiondef(to_regprocedure('private.current_business_date()')) as definition",
  )).rows[0].definition;
  const original = await definition();
  const marker = path.resolve(".supabase-worktree/claim-clock-restore.json");
  try {
    await readFile(marker);
    throw new Error("An interrupted clock fixture requires isolated DB reset/restoration before reuse");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { await database.end(); throw error; }
  }
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify({ original, resetRequiredIfInterrupted: true }), { flag: "wx", mode: 0o600 });
  const setDate = async (value: string) => {
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error("Invalid fixture civil date");
    await database.query(`create or replace function private.current_business_date() returns date language sql stable set search_path = '' as $$ select date '${value}' $$`);
    await database.query("revoke all on function private.current_business_date() from public, anon, authenticated, service_role");
  };
  try {
    await setDate(date);
    return await run({ setDate });
  } finally {
    try {
      if (original) await database.query(original);
      else await database.query("drop function private.current_business_date()");
      if (await definition() !== original) throw new Error("Claim clock restoration failed; reset the isolated DB before reuse");
      await unlink(marker);
    } finally {
      await database.query("select pg_advisory_unlock(238, 7)");
      await database.end();
    }
  }
}
