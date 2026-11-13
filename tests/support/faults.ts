import { Client } from "pg";
import { inject } from "vitest";

/** Fail only this synthetic Organization name, then always remove the fault. */
export async function withOrganizationCreateStorageFault<T>(operation: () => Promise<T>): Promise<T> {
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query(`create function private.test_reject_organization_create_292() returns trigger
      language plpgsql as $$ begin if new.name = 'Storage failure customer' then
      raise exception 'controlled storage failure'; end if; return new; end $$;
      create trigger test_reject_organization_create_292 before insert on public.organization
      for each row execute function private.test_reject_organization_create_292();`);
    return await operation();
  } finally {
    try {
      await database.query("drop trigger if exists test_reject_organization_create_292 on public.organization; drop function if exists private.test_reject_organization_create_292()");
    } finally { await database.end(); }
  }
}

/** Remove only the disposable queue schema allocated by the upload fault harness. */
export async function removeIsolatedUploadQueueFixture(schema: string) {
  if (!/^resume_[a-f0-9]{32}$/.test(schema)) throw new Error("Invalid isolated upload queue fixture schema");
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try { await database.query(`drop schema "${schema}" cascade`); }
  finally { await database.end(); }
}
