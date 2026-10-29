import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { Client as DatabaseClient } from "pg";
import type { Database } from "@/lib/database.types";

async function browserFixtureEnvironment() {
  const contents = await fs.readFile(".env.local", "utf8");
  return Object.fromEntries(contents.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function browserFixtureClient() {
  const environment = await browserFixtureEnvironment();
  return createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Platform configuration fixture for browser tests that need the real worker. */
export async function assignBrowserAiConfigurationFixture(companyId: string) {
  const environment = await browserFixtureEnvironment();
  const database = new DatabaseClient({ connectionString: environment.DATABASE_URL });
  await database.connect();
  try {
    await database.query("begin");
    await database.query(
      "insert into public.platform_ai_provider (provider) values ('fake') on conflict (provider) do nothing",
    );
    const configurationId = crypto.randomUUID();
    const credential = `browser-${crypto.randomUUID()}`;
    const secret = await database.query<{ id: string }>(
      "select vault.create_secret($1, $2, 'Browser test AI Configuration') as id",
      [credential, `ai_configuration_${configurationId}`],
    );
    await database.query(
      `insert into public.ai_configuration (
        id, label, provider, split_model, extract_model,
        credential_secret_id, credential_last_four
      ) values ($1, $2, 'fake', 'fake-split', 'fake-extract', $3, $4)`,
      [configurationId, `Browser test ${configurationId}`, secret.rows[0].id, credential.slice(-4)],
    );
    await database.query(
      "insert into public.company_ai_configuration (company_id, configuration_id) values ($1, $2)",
      [companyId, configurationId],
    );
    await database.query(
      "update public.company set ai_processing_enabled = true where id = $1",
      [companyId],
    );
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

/** Adds one immutable current Version with a warning for readiness browser coverage. */
export async function addBrowserDocumentWarningFixture(documentId: string) {
  const environment = await browserFixtureEnvironment();
  const database = new DatabaseClient({ connectionString: environment.DATABASE_URL });
  await database.connect();
  try {
    await database.query(
      `insert into public.extraction_version (
        organization_id, company_id, document_id, version,
        author_user_id, payload, findings
      )
      select
        current.organization_id,
        current.company_id,
        current.document_id,
        current.version + 1,
        membership.user_id,
        current.payload,
        '[{"field":"supplier.vatId","severity":"warning","code":"vat_registry_check_not_performed"}]'::jsonb
      from public.extraction_version current
      join public.document document on document.id = current.document_id
      join lateral (
        select candidate.user_id
        from public.membership candidate
        where candidate.organization_id = document.organization_id
          and candidate.role = 'administrator'
          and candidate.user_id is not null
        order by candidate.company_id nulls first
        limit 1
      ) membership on true
      where current.document_id = $1
        and current.version = (
          select max(candidate.version)
          from public.extraction_version candidate
          where candidate.document_id = current.document_id
        )`,
      [documentId],
    );
  } finally {
    await database.end();
  }
}

/** Browser-fixture setup for a user who signed up through the real UI. */
export async function addBrowserCompanyMemberFixture(companyId: string, email: string) {
  const service = await browserFixtureClient();
  const [{ data: company }, { data: users }] = await Promise.all([
    service.from("company").select("organization_id").eq("id", companyId).single(),
    service.auth.admin.listUsers(),
  ]);
  const userId = users.users.find((user) => user.email === email)?.id;
  if (!company || !userId) throw new Error("Could not prepare regular User browser fixture");
  const membership = await service.from("membership").insert({
    company_id: companyId,
    email,
    organization_id: company.organization_id,
    role: "user",
    user_id: userId,
  });
  if (membership.error) throw membership.error;
}

/** Browser-fixture setup for a SuperAdmin who signed up through the real UI. */
export async function promoteBrowserSuperAdminFixture(email: string) {
  const service = await browserFixtureClient();
  const { data: users, error: usersError } = await service.auth.admin.listUsers();
  if (usersError) throw usersError;
  const userId = users.users.find((user) => user.email === email)?.id;
  if (!userId) throw new Error("Could not prepare SuperAdmin browser fixture");
  const promoted = await service.from("platform_user").insert({
    role: "super_admin",
    user_id: userId,
  });
  if (promoted.error) throw promoted.error;
}
