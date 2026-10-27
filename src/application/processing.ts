import { AiProviderError, type AiInput, type AiProvider, type PageRange } from "./ai-provider";
import type { SystemClient } from "./client";
import type { DocumentStatus } from "./documents";
import {
  pdfPages,
  SOURCE_FILE_BUCKET,
  SOURCE_FILE_MEDIA_TYPES,
  sourceFileObjectPath,
  type SourceFileFormat,
  type SourceFileStatus,
} from "./source-files";

// Background processing (ADR-0004): Split per Source File, then Extract per
// Document. Jobs carry only ids; the state lives in the database, which makes
// every job safe to retry or to enqueue twice.

export type ProcessingJob =
  | { name: "split-source-file"; data: { sourceFileId: string } }
  | { name: "extract-document"; data: { documentId: string } };

export const splitJob = (sourceFileId: string): ProcessingJob => ({
  name: "split-source-file",
  data: { sourceFileId },
});
export const extractJob = (documentId: string): ProcessingJob => ({
  name: "extract-document",
  data: { documentId },
});

export const PROCESSING_JOB_NAMES: ProcessingJob["name"][] = ["split-source-file", "extract-document"];

export interface JobQueue {
  send(job: ProcessingJob): Promise<void>;
}

export type Worker = { system: SystemClient; ai: AiProvider; jobs: JobQueue };

/** Whether this is the job's last attempt; a technical failure then marks its target Failed. */
export type Attempt = { final: boolean };

/** Runs one job. The worker process and the tests both run jobs through here. */
export async function runJob(worker: Worker, job: ProcessingJob, attempt: Attempt): Promise<void> {
  switch (job.name) {
    case "split-source-file":
      return splitSourceFile(worker, job.data.sourceFileId, attempt);
    case "extract-document":
      return extractDocument(worker, job.data.documentId, attempt);
  }
}

/** Whether the Company has consented to AI processing by this provider in this region. */
async function consentsTo(system: SystemClient, companyId: string, ai: AiProvider): Promise<boolean> {
  const { data, error } = await system
    .from("company")
    .select("ai_processing_enabled, ai_provider, ai_region")
    .eq("id", companyId)
    .single();
  if (error) throw error;
  return data.ai_processing_enabled && data.ai_provider === ai.name && data.ai_region === ai.region;
}

async function download(system: SystemClient, companyId: string, sourceFileId: string): Promise<Uint8Array> {
  const { data, error } = await system.storage
    .from(SOURCE_FILE_BUCKET)
    .download(sourceFileObjectPath(companyId, sourceFileId));
  if (error) throw error;
  return new Uint8Array(await data.arrayBuffer());
}

/** Runs `work`, marking the target Failed when it throws on the final attempt. */
async function failOnFinalAttempt(attempt: Attempt, markFailed: () => Promise<void>, work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    if (attempt.final || (error instanceof AiProviderError && !error.transient)) await markFailed();
    throw error;
  }
}

async function splitSourceFile({ system, ai, jobs }: Worker, sourceFileId: string, attempt: Attempt) {
  const { data: file, error } = await system
    .from("source_file")
    .select("id, organization_id, company_id, format, page_count, status")
    .eq("id", sourceFileId)
    .single();
  if (error) throw error;
  if (file.status === "failed") return;

  if (file.status !== "split") {
    if (!(await consentsTo(system, file.company_id, ai))) return;
    // Moves the status only from the given ones, so a job that read a stale status cannot undo another's result.
    const moveStatus = async (to: SourceFileStatus, from: SourceFileStatus[]) => {
      const { data, error } = await system
        .from("source_file")
        .update({ status: to })
        .eq("id", file.id)
        .in("status", from)
        .select("id");
      if (error) throw error;
      return data.length > 0;
    };
    await failOnFinalAttempt(attempt, () => moveStatus("failed", ["processing"]).then(() => undefined), async () => {
      if (!(await moveStatus("processing", ["uploaded", "processing"]))) return;
      const bytes = await download(system, file.company_id, file.id);
      const { documents, model, usage } = await ai.split(aiInput(file.format, bytes, file.page_count), {
        organizationId: file.organization_id,
      });
      const metered = await system.rpc("record_ai_usage", {
        target_organization_id: file.organization_id,
        target_company_id: file.company_id,
        target_provider: ai.name,
        target_model: model,
        target_operation: "split",
        target_input_tokens: usage?.inputTokens ?? 0,
        target_output_tokens: usage?.outputTokens ?? 0,
        target_job_name: "split-source-file",
        target_job_id: file.id,
      });
      if (metered.error) throw metered.error;
      const { error } = await system.rpc("record_split", { target_source_file_id: file.id, page_ranges: documents });
      if (error) throw error;
    });
  }

  // Enqueues the Documents of the recorded Split, including when an earlier attempt recorded it.
  const { data: documents, error: listError } = await system
    .from("document")
    .select("id")
    .eq("source_file_id", file.id)
    .is("superseded_at", null)
    .eq("status", "uploaded")
    .order("first_page");
  if (listError) throw listError;
  for (const document of documents) await jobs.send(extractJob(document.id));
}

async function extractDocument({ system, ai }: Worker, documentId: string, attempt: Attempt) {
  const { data: document, error } = await system
    .from("document")
    .select("id, organization_id, company_id, source_file_id, first_page, last_page, status, superseded_at, extraction_request_id, source_file (format)")
    .eq("id", documentId)
    .single();
  if (error) throw error;
  if (document.superseded_at !== null || (document.status !== "uploaded" && document.status !== "processing")) return;
  if (!(await consentsTo(system, document.company_id, ai))) return;

  // Moves the status of this Extraction request only from the given ones (see splitSourceFile).
  const moveStatus = async (to: DocumentStatus, from: DocumentStatus[]) => {
    const { data, error } = await system
      .from("document")
      .update({ status: to })
      .eq("id", document.id)
      .eq("extraction_request_id", document.extraction_request_id)
      .in("status", from)
      .select("id");
    if (error) throw error;
    return data.length > 0;
  };

  await failOnFinalAttempt(attempt, () => moveStatus("failed", ["processing"]).then(() => undefined), async () => {
    if (!(await moveStatus("processing", ["uploaded", "processing"]))) return;
    const bytes = await download(system, document.company_id, document.source_file_id);
    const range = { firstPage: document.first_page, lastPage: document.last_page };
    const input = await documentInput(document.source_file!.format, bytes, range);
    const { model, payload, usage } = await ai.extract(input, { organizationId: document.organization_id });
    const metered = await system.rpc("record_ai_usage", {
      target_organization_id: document.organization_id,
      target_company_id: document.company_id,
      target_provider: ai.name,
      target_model: model,
      target_operation: "extract",
      target_input_tokens: usage?.inputTokens ?? 0,
      target_output_tokens: usage?.outputTokens ?? 0,
      target_job_name: "extract-document",
      target_job_id: document.id,
    });
    if (metered.error) throw metered.error;
    const { error } = await system.rpc("record_ai_extraction", {
      target_document_id: document.id,
      target_extraction_request_id: document.extraction_request_id,
      provider: ai.name,
      model,
      payload,
    });
    if (error) throw error;
  });
}

function aiInput(format: SourceFileFormat, bytes: Uint8Array, pageCount: number): AiInput {
  return { format, mediaType: SOURCE_FILE_MEDIA_TYPES[format], bytes, pageCount };
}

/** The Document's own pages: a PDF of just its range, or the whole image. */
async function documentInput(format: SourceFileFormat, bytes: Uint8Array, range: PageRange): Promise<AiInput> {
  if (format !== "pdf") return aiInput(format, bytes, 1);
  return aiInput(format, await pdfPages(bytes, range), range.lastPage - range.firstPage + 1);
}
