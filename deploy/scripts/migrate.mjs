import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  // The session lock serializes concurrent releases, including first bootstrap.
  await client.query("select pg_advisory_lock(482019630)");
  await client.query(`create schema if not exists ivat_deploy;
    revoke all on schema ivat_deploy from public, anon, authenticated, service_role;
    create table if not exists ivat_deploy.migration (name text primary key, sha256 text not null, applied_at timestamptz not null default now())`);
  const applied = new Map((await client.query("select name, sha256 from ivat_deploy.migration")).rows.map(row => [row.name, row.sha256]));
  const files = (await readdir("supabase/migrations")).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  // Validate all history before applying any pending migration.
  const migrations = await Promise.all(files.map(async name => {
    const sql = await readFile(`supabase/migrations/${name}`, "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    if (applied.has(name) && applied.get(name) !== sha256) throw new Error(`Applied migration changed: ${name}`);
    return { name, sql, sha256 };
  }));
  for (const name of applied.keys()) if (!files.includes(name)) throw new Error(`Applied migration missing from release: ${name}`);
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    await client.query("begin");
    try {
      await client.query(migration.sql);
      await client.query("insert into ivat_deploy.migration (name, sha256) values ($1, $2)", [migration.name, migration.sha256]);
      await client.query("commit");
      console.log(`Applied ${migration.name}`);
    } catch (error) {
      await client.query("rollback");
      throw new Error(`Migration failed: ${migration.name}`, { cause: error });
    }
  }
  await client.query("notify pgrst, 'reload schema'");
  console.log("Database migrations complete.");
} finally {
  await client.end();
}
