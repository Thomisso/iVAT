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

/** Adds one durable completed batch and its User-owned notification. */
export async function addBrowserUploadNotificationFixture(companyId: string, email: string) {
  const environment = await browserFixtureEnvironment();
  const database = new DatabaseClient({ connectionString: environment.DATABASE_URL });
  await database.connect();
  try {
    await database.query("begin");
    const target = await database.query<{ organization_id: string; user_id: string }>(
      `select company.organization_id, auth_user.id as user_id
       from public.company company
       cross join auth.users auth_user
       where company.id = $1 and auth_user.email = $2`,
      [companyId, email],
    );
    if (!target.rows[0]) throw new Error("Could not prepare browser notification fixture");
    const batch = await database.query<{ id: string }>(
      `insert into public.upload_batch (
         organization_id, company_id, created_by, file_count,
         upload_finished_at, processing_finished_at
       ) values ($1, $2, $3, 1, now(), now())
       returning id`,
      [target.rows[0].organization_id, companyId, target.rows[0].user_id],
    );
    await database.query(
      `insert into public.notification (
         organization_id, company_id, user_id, kind, payload
       ) values (
         $1, $2, $3, 'upload_batch_finished',
         jsonb_build_object(
           'batchId', $4::uuid,
           'fileCount', 1,
           'outcome', 'success',
           'reviewCount', 1,
           'transportFailureCount', 0,
           'sourceFailureCount', 0,
           'documentFailureCount', 0
         )
       )`,
      [target.rows[0].organization_id, companyId, target.rows[0].user_id, batch.rows[0].id],
    );
    await database.query("commit");
    return batch.rows[0].id;
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
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
    await database.query(
      "insert into public.platform_ai_provider (provider) values ('fake') on conflict (provider) do nothing",
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

/** Creates one failed pg-boss split job whose target can be safely retried. */
export async function addBrowserTerminalProcessingJobFixture(companyId: string) {
  const environment = await browserFixtureEnvironment();
  const database = new DatabaseClient({ connectionString: environment.DATABASE_URL });
  const service = await browserFixtureClient();
  const retrySourceFileId = crypto.randomUUID();
  let copiedObject = false;
  let transactionStarted = false;
  await database.connect();
  try {
    const source = await database.query<{ id: string }>(
      `select id from public.source_file
       where company_id = $1
       order by uploaded_at desc limit 1`,
      [companyId],
    );
    if (!source.rows[0]) throw new Error("Could not prepare terminal processing fixture");
    const copied = await service.storage.from("source-files").copy(
      `${companyId}/${source.rows[0].id}`,
      `${companyId}/${retrySourceFileId}`,
    );
    if (copied.error) throw copied.error;
    copiedObject = true;

    await database.query("begin");
    transactionStarted = true;
    await database.query(
      `insert into public.source_file (
         id, organization_id, company_id, file_name, format,
         byte_size, sha256, page_count, uploaded_by, status
       )
       select
         $2, organization_id, company_id, file_name, format,
         byte_size, sha256, page_count, uploaded_by, 'failed'
       from public.source_file
       where id = $1`,
      [source.rows[0].id, retrySourceFileId],
    );
    const inserted = await database.query<{ id: string }>(
      `insert into pgboss.job (
         name, data, state, retry_limit, started_on, completed_on, output
       ) values (
         'split-source-file', jsonb_build_object('sourceFileId', $1::uuid),
         'failed', 0, now(), now(), '{"message":"browser terminal failure"}'::jsonb
       ) returning id`,
      [retrySourceFileId],
    );
    await database.query("commit");
    transactionStarted = false;
    return { jobId: inserted.rows[0].id, sourceFileId: retrySourceFileId };
  } catch (error) {
    if (transactionStarted) await database.query("rollback");
    if (copiedObject) {
      await service.storage.from("source-files").remove([`${companyId}/${retrySourceFileId}`]);
    }
    throw error;
  } finally {
    await database.end();
  }
}

/** Reads the durable state reached by a retried Source File. */
export async function browserSourceFileStatus(sourceFileId: string) {
  const environment = await browserFixtureEnvironment();
  const database = new DatabaseClient({ connectionString: environment.DATABASE_URL });
  await database.connect();
  try {
    const result = await database.query<{ status: string }>(
      "select status from public.source_file where id = $1",
      [sourceFileId],
    );
    return result.rows[0]?.status ?? null;
  } finally {
    await database.end();
  }
}

/** Parks the latest Source File behind an authoritative missing-configuration issue. */
export async function addBrowserMissingConfigurationIssueFixture(companyId: string) {
  const environment = await browserFixtureEnvironment();
  const database = new DatabaseClient({ connectionString: environment.DATABASE_URL });
  await database.connect();
  try {
    await database.query("begin");
    await database.query(
      "insert into public.platform_ai_provider (provider) values ('fake') on conflict (provider) do nothing",
    );
    const source = await database.query<{ id: string; organization_id: string }>(
      `select id, organization_id from public.source_file
       where company_id = $1
       order by uploaded_at desc limit 1
       for update`,
      [companyId],
    );
    if (!source.rows[0]) throw new Error("Could not prepare missing-configuration fixture");
    await database.query(
      "update public.company set ai_processing_enabled = true where id = $1",
      [companyId],
    );
    await database.query(
      "update public.source_file set status = 'waiting_for_platform' where id = $1",
      [source.rows[0].id],
    );
    await database.query(
      `insert into public.ai_processing_issue (
         target_kind, target_id, organization_id, company_id,
         classification, state
       ) values ('source_file', $1, $2, $3, 'configuration_missing', 'waiting_for_platform')
       on conflict (target_kind, target_id) do update set
         classification = excluded.classification,
         state = excluded.state,
         configuration_id = null,
         provider = null,
         updated_at = now()`,
      [source.rows[0].id, source.rows[0].organization_id, companyId],
    );
    await database.query("commit");
    return source.rows[0].id;
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

/** Reads the privileged remediation audit actions written for browser fixtures. */
export async function browserRemediationAuditActions(targetIds: string[]) {
  const environment = await browserFixtureEnvironment();
  const database = new DatabaseClient({ connectionString: environment.DATABASE_URL });
  await database.connect();
  try {
    const result = await database.query<{ action: string }>(
      `select action from public.audit_event
       where target_id = any($1::uuid[])
       order by occurred_at, id`,
      [targetIds],
    );
    return result.rows.map((row) => row.action);
  } finally {
    await database.end();
  }
}

/** Adds one current Version that sets a Document's Direction and Tax Point Date, for Reporting Period browser coverage. */
export async function setBrowserDocumentTaxPointFixture(
  documentId: string,
  values: { direction: "incoming" | "outgoing"; taxPointDate: string },
) {
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
        current.payload || jsonb_build_object('direction', $2::text, 'taxPointDate', $3::text),
        current.findings
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
      [documentId, values.direction, values.taxPointDate],
    );
  } finally {
    await database.end();
  }
}

/** Ensures a monthly Reporting Year exists, for browser specs whose fake extraction is dated outside the current year. */
export async function ensureBrowserReportingYearFixture(companyId: string, year: number) {
  const environment = await browserFixtureEnvironment();
  const database = new DatabaseClient({ connectionString: environment.DATABASE_URL });
  await database.connect();
  try {
    await database.query(
      `insert into public.reporting_year (company_id, organization_id, year, frequency)
      select id, organization_id, $2, 'monthly' from public.company where id = $1
      on conflict (company_id, year) do nothing`,
      [companyId, year],
    );
  } finally {
    await database.end();
  }
}
