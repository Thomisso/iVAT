import {
  createCompany,
  type CompanySettingsInput,
} from "@/application/companies";
import type { AiProvider } from "@/application/ai-provider";
import type { AppClient, Result } from "@/application/client";
import { extractJob, splitJob, type JobQueue } from "@/application/processing";
import { Client as DatabaseClient } from "pg";
import { inject } from "vitest";
import { signedUpUser } from "./clients";
import { systemClient } from "./worker";

let icoCounter = 0;

/**
 * Test-only platform provisioning boundary. Production Companies receive an AI
 * Configuration only through SuperAdmin commands; integration tests provision
 * one directly so they can focus on their own behavior without a second actor.
 */
export async function assignAiConfigurationFixture(
  _client: AppClient,
  jobs: JobQueue,
  input: { companyId: string; provider: Pick<AiProvider, "name" | "region"> },
): Promise<Result<null, "fixture_failed">> {
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query("begin");
    await database.query(
      "insert into public.platform_ai_provider (provider) values ($1) on conflict (provider) do nothing",
      [input.provider.name],
    );
    const configurationId = crypto.randomUUID();
    const credential = `test-${crypto.randomUUID()}`;
    const secret = await database.query<{ id: string }>(
      "select vault.create_secret($1, $2, 'Integration test AI Configuration') as id",
      [credential, `ai_configuration_${configurationId}`],
    );
    await database.query(
      `insert into public.ai_configuration (
        id, label, provider, split_model, extract_model,
        credential_secret_id, credential_last_four
      ) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        configurationId,
        `Test ${input.provider.name} ${configurationId}`,
        input.provider.name,
        `${input.provider.name}-split`,
        `${input.provider.name}-extract`,
        secret.rows[0].id,
        credential.slice(-4),
      ],
    );
    await database.query(
      `insert into public.company_ai_configuration (company_id, configuration_id)
       values ($1, $2)
       on conflict (company_id) do update set configuration_id = excluded.configuration_id`,
      [input.companyId, configurationId],
    );
    await database.query(
      "update public.company set ai_processing_enabled = true where id = $1",
      [input.companyId],
    );
    await database.query(
      `insert into public.company_setup_step_state (company_id, organization_id, step, state, changed_by)
       select id, organization_id, 'ai_processing', 'completed', null
       from public.company where id = $1
       on conflict (company_id, step) do update set state = excluded.state, changed_by = null, changed_at = now()`,
      [input.companyId],
    );
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }

  const system = systemClient();
  const [sources, documents] = await Promise.all([
    system.from("source_file").select("id").eq("company_id", input.companyId)
      .in("status", ["uploaded", "processing", "waiting_for_platform"]),
    system.from("document").select("id").eq("company_id", input.companyId)
      .in("status", ["uploaded", "processing", "waiting_for_platform"]),
  ]);
  if (sources.error) throw sources.error;
  if (documents.error) throw documents.error;
  for (const source of sources.data) await jobs.send(splitJob(source.id));
  for (const document of documents.data) await jobs.send(extractJob(document.id));
  return { ok: true as const, value: null };
}

/** Test-only removal of a platform assignment. */
export async function removeAiConfigurationFixture(_client: AppClient, companyId: string) {
  const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    await database.query("begin");
    await database.query("delete from public.company_ai_configuration where company_id = $1", [companyId]);
    await database.query("update public.company set ai_processing_enabled = false where id = $1", [companyId]);
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
  return { ok: true as const, value: null };
}

/** A random but well-formed set of Company details. */
export function companyDetails(
  overrides: Partial<CompanySettingsInput> = {},
): CompanySettingsInput {
  const ico = String(
    10_000_000 + ((Date.now() + icoCounter++) % 89_999_999),
  ).slice(0, 8);
  return {
    name: "Novák s.r.o.",
    firstName: "",
    lastName: "",
    ico,
    vatId: `CZ${ico}`,
    streetName: "Vinohradská",
    houseNumber: "12",
    orientationNumber: "",
    city: "Praha",
    postalCode: "120 00",
    personType: "legal",
    filingFrequency: "monthly",
    filingFrequencyEffectiveFrom: "2026-01-01",
    ...overrides,
  };
}

/** A signed-up Organization Administrator whose Organization holds one Company. */
export async function administratorWithCompany(
  organizationName = "Test Organization",
) {
  const user = await signedUpUser(organizationName);
  const result = await createCompany(user.client, {
    organizationId: user.organizationId,
    ...companyDetails(),
  });
  if (!result.ok) throw new Error(`Company creation failed: ${result.error}`);
  return { ...user, companyId: result.value.id };
}

/**
 * A signed-up user who is a member of the Company with the given Role. Until
 * invitations exist (#23), the Membership is recorded directly with the secret key.
 */
export async function companyMember(
  { organizationId, companyId }: { organizationId: string; companyId: string },
  role: "administrator" | "user" = "user",
) {
  const user = await signedUpUser("Member's own Organization");
  const { error } = await systemClient()
    .from("membership")
    .insert({
      user_id: user.userId,
      organization_id: organizationId,
      company_id: companyId,
      email: user.email,
      role,
    });
  if (error) throw error;
  return user;
}

/** Support-only corruption fixture for exercising the database's Finalization
 * guard. The Application never removes a required completed setup step. */
export async function removeCompletedCompanyIdentityFixture(companyId: string) {
  const removed = await systemClient()
    .from("company_setup_step_state")
    .delete()
    .eq("company_id", companyId)
    .eq("step", "identity");
  if (removed.error) throw removed.error;
}

/** Large report fixture. Uses platform-sized Source Files and the worker's narrow
 * write functions to avoid 1001 full PDF extraction jobs; application tests still
 * generate/read as a User. */
export async function companyWithManyReportDocuments(count: number) {
  const { PDFDocument } = await import("pdf-lib");
  const { uploadSourceFile } = await import("@/application/source-files");
  const { SAMPLE_EXTRACTION } = await import("@/ai/fake");
  const admin = await administratorWithCompany();
  const system = systemClient();
  const unlimited = await system
    .from("company")
    .update({ ai_processing_allowance: null })
    .eq("id", admin.companyId);
  if (unlimited.error) throw unlimited.error;
  await assignAiConfigurationFixture(admin.client, { async send() {} }, {
    companyId: admin.companyId,
    provider: { name: "fake", region: "local" },
  });
  for (let first = 0; first < count; first += 50) {
    const pageCount = Math.min(50, count - first);
    const pdf = await PDFDocument.create();
    for (let page = 0; page < pageCount; page++) pdf.addPage();
    const file = await uploadSourceFile(
      admin.client,
      { async send() {} },
      {
        companyId: admin.companyId,
        fileName: `many-${first / 50 + 1}.pdf`,
        bytes: await pdf.save(),
      },
    );
    if (!file.ok) throw new Error(file.error);
    const split = await system.rpc("record_split", {
      target_source_file_id: file.value.id,
      source_ranges: Array.from({ length: pageCount }, (_, i) => ({
        firstPage: i + 1,
        lastPage: i + 1,
      })),
    });
    if (split.error) throw split.error;
  }
  for (let offset = 0; offset < count; offset += 100) {
    const { data, error } = await system
      .from("document")
      .select("id, extraction_request_id")
      .eq("company_id", admin.companyId)
      .order("id")
      .range(offset, offset + 99);
    if (error) throw error;
    await Promise.all(
      data.map(async (d) => {
        const reservationId = crypto.randomUUID();
        const reservation = await system.rpc("reserve_ai_processing", {
          target_document_id: d.id,
          target_extraction_request_id: d.extraction_request_id,
          target_reservation_id: reservationId,
        });
        if (reservation.error) throw reservation.error;
        if (reservation.data !== "reserved") throw new Error(`Extraction fixture was not reserved: ${reservation.data}`);
        const result = await system.rpc("record_ai_extraction", {
          target_document_id: d.id,
          target_extraction_request_id: d.extraction_request_id,
          target_reservation_id: reservationId,
          provider: "fake",
          model: "fake-extract",
          payload: SAMPLE_EXTRACTION,
          findings: [],
        });
        if (result.error) throw result.error;
      }),
    );
  }
  return admin;
}

/** A large, finalizable VAT Report fixture approved through the Application layer. */
export async function companyWithManyApprovedReportDocuments(count: number) {
  const { approveDocument, listCompanyDocuments } = await import("@/application/documents");
  const company = await companyWithManyReportDocuments(count);
  const documents = await listCompanyDocuments(company.client, company.companyId);
  for (let offset = 0; offset < documents.length; offset += 25) {
    const results = await Promise.all(documents.slice(offset, offset + 25).map((document) =>
      approveDocument(company.client, {
        companyId: company.companyId,
        documentId: document.id,
        version: 1,
      })
    ));
    for (const result of results) {
      if (!result.ok) throw new Error(`Document approval failed: ${result.error}`);
    }
  }
  return company;
}

/** A Company with more than one PostgREST page of uploaded Documents waiting for Extraction. */
export async function companyWithWaitingDocuments(count: number) {
  const { PDFDocument } = await import("pdf-lib");
  const { uploadSourceFile } = await import("@/application/source-files");
  const admin = await administratorWithCompany("Paged AI resume");
  const pageCount = Math.min(50, count);
  const pdf = await PDFDocument.create();
  for (let page = 0; page < pageCount; page++) pdf.addPage();
  const bytes = await pdf.save();
  let created = 0;
  while (created < count) {
    const documentsInFile = Math.min(pageCount, count - created);
    const uploaded = await uploadSourceFile(admin.client, { async send() {} }, {
      companyId: admin.companyId,
      fileName: `waiting-${created / pageCount + 1}.pdf`,
      bytes,
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    const split = await systemClient().rpc("record_split", {
      target_source_file_id: uploaded.value.id,
      source_ranges: Array.from({ length: documentsInFile }, (_, page) => ({
        firstPage: page + 1,
        lastPage: page + 1,
      })),
    });
    if (split.error) throw split.error;
    created += documentsInFile;
  }
  return admin;
}

/** A real-user Upload Batch with more Documents than one PostgREST page.
 * Worker-only split setup stays inside test support; assertions use Application queries. */
export async function uploadBatchWithWaitingDocuments(count: number) {
  const { PDFDocument } = await import("pdf-lib");
  const { beginUploadBatch, finishUploadBatch } = await import("@/application/upload-batches");
  const { uploadSourceFile } = await import("@/application/source-files");
  const admin = await administratorWithCompany("Paged upload batch");
  const fileCount = Math.ceil(count / 50);
  const batch = await beginUploadBatch(admin.client, { companyId: admin.companyId, fileCount });
  if (!batch.ok) throw new Error(batch.error);
  const pdf = await PDFDocument.create();
  for (let page = 0; page < 50; page++) pdf.addPage();
  const bytes = await pdf.save();
  let created = 0;
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
    const uploaded = await uploadSourceFile(admin.client, { async send() {} }, {
      companyId: admin.companyId,
      batchId: batch.value.id,
      fileName: `large-${fileIndex}.pdf`,
      bytes,
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    const documentsInFile = Math.min(50, count - created);
    const split = await systemClient().rpc("record_split", {
      target_source_file_id: uploaded.value.id,
      source_ranges: Array.from({ length: documentsInFile }, (_, page) => ({
        firstPage: page + 1,
        lastPage: page + 1,
      })),
    });
    if (split.error) throw split.error;
    created += documentsInFile;
  }
  await finishUploadBatch(admin.client, batch.value.id);
  return { ...admin, batchId: batch.value.id };
}
