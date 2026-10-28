import { AiProviderError, type AiInput, type AiProvider, type PageRange, type RowRange } from "./ai-provider";
import type { SystemClient } from "./client";
import {
  CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA,
  validateDocument,
} from "./document-validation";
import type { DocumentStatus } from "./documents";
import {
  pdfPages,
  SOURCE_FILE_BUCKET,
  SOURCE_FILE_MEDIA_TYPES,
  sourceFileObjectPath,
  type SourceFileFormat,
  type SourceFileStatus,
} from "./source-files";
import { workbookRowsToText, workbookToText } from "./workbooks";
import {
  vatRegistryFindings,
  type VatPayerRegistry,
} from "./vat-registry";
import { detectDocumentDirection } from "./direction-detection";
import type { Direction } from "./extraction-payload";
import { applyCnbConversion, type ExchangeRateProvider } from "./exchange-rates";
import { createHash } from "node:crypto";
import { buildCompanyDataArchive, type CompanyExportSnapshot } from "./company-data-export";
import type { CompanyDataExportStatus } from "@/lib/company-data-export-status";

// Background processing (ADR-0004): Split per Source File, then Extract per
// Document. Jobs carry only ids; the state lives in the database, which makes
// every job safe to retry or to enqueue twice.

export type ProcessingJob =
  | { name: "split-source-file"; data: { sourceFileId: string } }
  | { name: "extract-document"; data: { documentId: string } }
  | { name: "complete-company-export"; data: { exportId: string } };

export const splitJob = (sourceFileId: string): ProcessingJob => ({
  name: "split-source-file",
  data: { sourceFileId },
});
export const extractJob = (documentId: string): ProcessingJob => ({
  name: "extract-document",
  data: { documentId },
});
export const completeCompanyExportJob = (exportId: string): ProcessingJob => ({
  name: "complete-company-export",
  data: { exportId },
});

export const PROCESSING_JOB_NAMES: ProcessingJob["name"][] = [
  "split-source-file",
  "extract-document",
  "complete-company-export",
];

export interface JobQueue {
  send(job: ProcessingJob, options?: { startAfterSeconds?: number }): Promise<void>;
}

export interface AiProviderRegistry {
  get(provider: string): AiProvider | undefined;
}

export type Worker = {
  system: SystemClient;
  providers: AiProviderRegistry;
  jobs: JobQueue;
  vatRegistry: VatPayerRegistry;
  exchangeRates: ExchangeRateProvider;
};

/** Whether this is the job's last attempt; a technical failure then marks its target Failed. */
export type Attempt = { final: boolean };

/** Runs one job. The worker process and the tests both run jobs through here. */
export async function runJob(worker: Worker, job: ProcessingJob, attempt: Attempt): Promise<void> {
  switch (job.name) {
    case "split-source-file":
      return splitSourceFile(worker, job.data.sourceFileId, attempt);
    case "extract-document":
      return extractDocument(worker, job.data.documentId, attempt);
    case "complete-company-export":
      return completeCompanyExport(worker.system, job.data.exportId, attempt);
  }
}

async function completeCompanyExport(
  system: SystemClient,
  exportId: string,
  attempt: Attempt,
): Promise<void> {
  await failOnFinalAttempt(attempt, async () => {
    const failed = await system.rpc("fail_company_data_export", { target_export_id: exportId });
    if (failed.error) throw failed.error;
  }, async () => {
    const loaded = await system.rpc("company_data_export_for_completion", { target_export_id: exportId });
    if (loaded.error) throw loaded.error;
    const receipt = loaded.data as unknown as {
      status: CompanyDataExportStatus;
      companyId: string;
      snapshot: CompanyExportSnapshot;
    };
    if (receipt.status !== "pending") return;
    const bytes = await buildCompanyDataArchive(receipt.snapshot, async (sourceFile) => {
      const stored = await system.storage
        .from(SOURCE_FILE_BUCKET)
        .download(sourceFileObjectPath(receipt.companyId, sourceFile.id));
      if (stored.error) throw stored.error;
      return new Uint8Array(await stored.data.arrayBuffer());
    });
    if (!bytes) throw new Error("Company export source file is missing");
    const completed = await system.rpc("complete_company_data_export", {
      target_export_id: exportId,
      target_byte_size: bytes.byteLength,
      target_sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    // A concurrent Company change permanently makes this snapshot stale. The
    // authenticated status query exposes that terminal state to the browser.
    if (completed.error?.code === "P0001" && completed.error.hint === "stale_export") return;
    if (completed.error) throw completed.error;
  });
}

type ProviderAvailability = { blocked: boolean; provider: AiProvider | null };

/** The provider named by the Company's current consent, and whether platform blocking deferred it. */
async function providerAvailability(
  system: SystemClient,
  companyId: string,
  providers: AiProviderRegistry,
): Promise<ProviderAvailability> {
  const { data, error } = await system
    .from("company")
    .select("ai_processing_enabled, ai_provider, ai_region, organization:organization_id (blocked_at)")
    .eq("id", companyId)
    .single();
  if (error) throw error;
  if (data.organization?.blocked_at) return { blocked: true, provider: null };
  if (!data.ai_processing_enabled || !data.ai_provider) return { blocked: false, provider: null };
  const provider = providers.get(data.ai_provider);
  if (!provider || provider.region !== data.ai_region) {
    throw new AiProviderError(
      "provider_unavailable_on_worker",
      `AI provider "${data.ai_provider}" in region "${data.ai_region}" is not configured on this worker`,
      { transient: true },
    );
  }
  return { blocked: false, provider };
}

const BLOCKED_JOB_RECHECK_SECONDS = 60;

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

async function splitSourceFile({ system, providers, jobs }: Worker, sourceFileId: string, attempt: Attempt) {
  const { data: file, error } = await system
    .from("source_file")
    .select("id, organization_id, company_id, format, page_count, status")
    .eq("id", sourceFileId)
    .single();
  if (error) throw error;
  if (file.status === "failed") return;

  if (file.status !== "split") {
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
    await failOnFinalAttempt(attempt, () => moveStatus("failed", ["uploaded", "processing"]).then(() => undefined), async () => {
      const availability = await providerAvailability(system, file.company_id, providers);
      if (availability.blocked) {
        await jobs.send(splitJob(file.id), { startAfterSeconds: BLOCKED_JOB_RECHECK_SECONDS });
        return;
      }
      const ai = availability.provider;
      if (!ai) return;
      if (!(await moveStatus("processing", ["uploaded", "processing"]))) return;
      const bytes = await download(system, file.company_id, file.id);
      const input = sourceFileInput(file.format, bytes, file.page_count);
      const { documents, model, usage } = await ai.split(input, {
        organizationId: file.organization_id,
      });
      assertWorkbookRanges(input, documents);
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
      const { error } = await system.rpc("record_split", { target_source_file_id: file.id, source_ranges: documents });
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

async function extractDocument(
  { system, providers, jobs, vatRegistry, exchangeRates }: Worker,
  documentId: string,
  attempt: Attempt,
) {
  const { data: document, error } = await system
    .from("document")
    .select("id, organization_id, company_id, source_file_id, first_page, last_page, source_sheet, first_row, last_row, status, superseded_at, extraction_request_id, source_file (format, preselected_direction)")
    .eq("id", documentId)
    .single();
  if (error) throw error;
  if (document.superseded_at !== null || (document.status !== "uploaded" && document.status !== "processing")) return;

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

  await failOnFinalAttempt(attempt, () => moveStatus("failed", ["uploaded", "processing"]).then(() => undefined), async () => {
    const availability = await providerAvailability(system, document.company_id, providers);
    if (availability.blocked) {
      await jobs.send(extractJob(document.id), { startAfterSeconds: BLOCKED_JOB_RECHECK_SECONDS });
      return;
    }
    const ai = availability.provider;
    if (!ai) return;
    if (!(await moveStatus("processing", ["uploaded", "processing"]))) return;
    const bytes = await download(system, document.company_id, document.source_file_id);
    const range = document.first_row === null
      ? { firstPage: document.first_page, lastPage: document.last_page }
      : { sheetName: document.source_sheet!, firstRow: document.first_row, lastRow: document.last_row! };
    const input = await documentInput(document.source_file!.format, bytes, range);
    const { model, payload: extractedPayload, usage } = await ai.extract(input, { organizationId: document.organization_id });
    const { data: company, error: companyError } = await system
      .from("company")
      .select("ico, vat_id")
      .eq("id", document.company_id)
      .single();
    if (companyError) throw companyError;
    const directedPayload = {
      ...extractedPayload,
      direction: detectDocumentDirection(
        extractedPayload,
        { ico: company.ico, vatId: company.vat_id },
        document.source_file!.preselected_direction as Direction | null,
      ),
    };
    const conversion = await applyCnbConversion(directedPayload, exchangeRates);
    const payload = conversion.payload;
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
    const findings = [
      ...validateDocument(
        payload,
        CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA,
      ),
      ...(await vatRegistryFindings(vatRegistry, payload)),
      ...conversion.findings,
    ];
    const { error } = await system.rpc("record_ai_extraction", {
      target_document_id: document.id,
      target_extraction_request_id: document.extraction_request_id,
      provider: ai.name,
      model,
      payload,
      findings,
    });
    if (error) throw error;
  });
}

function binaryAiInput(format: SourceFileFormat, bytes: Uint8Array, pageCount: number): AiInput {
  return { format, mediaType: SOURCE_FILE_MEDIA_TYPES[format], bytes, pageCount };
}

function textAiInput(format: SourceFileFormat, text: string, workbookRowSets?: RowRange[]): AiInput {
  const bytes = new TextEncoder().encode(text);
  return { format, mediaType: "text/plain; charset=utf-8", bytes, pageCount: 1, text, workbookRowSets };
}

function sourceFileInput(format: SourceFileFormat, bytes: Uint8Array, pageCount: number): AiInput {
  if (format !== "xlsx" && format !== "xls") return binaryAiInput(format, bytes, pageCount);
  const workbook = workbookToText(bytes);
  return textAiInput(format, workbook.text, workbook.rowSets);
}

function assertWorkbookRanges(input: AiInput, ranges: (PageRange | RowRange)[]) {
  if (!input.workbookRowSets) return;
  const previousLastRow = new Map<string, number>();
  for (const range of ranges) {
    if (!("firstRow" in range)) throw new Error("A workbook Split must return row sets");
    const sheet = input.workbookRowSets.find(({ sheetName }) => sheetName === range.sheetName);
    if (
      !sheet ||
      range.firstRow < sheet.firstRow ||
      range.lastRow < range.firstRow ||
      range.lastRow > sheet.lastRow ||
      range.firstRow <= (previousLastRow.get(range.sheetName) ?? 0)
    ) {
      throw new Error("Workbook row sets must be ascending, disjoint, and within their worksheets");
    }
    previousLastRow.set(range.sheetName, range.lastRow);
  }
}

/** The Document's own pages: a PDF of just its range, or the whole image. */
async function documentInput(format: SourceFileFormat, bytes: Uint8Array, range: PageRange | RowRange): Promise<AiInput> {
  if ("firstRow" in range) return textAiInput(format, workbookRowsToText(bytes, range));
  if (format !== "pdf") return binaryAiInput(format, bytes, 1);
  return binaryAiInput(format, await pdfPages(bytes, range), range.lastPage - range.firstPage + 1);
}
