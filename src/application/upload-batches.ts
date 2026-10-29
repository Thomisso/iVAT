import { isUuid, type AppClient, type Result } from "./client";
import type { DocumentStatus } from "./documents";
import type { SourceFileStatus } from "./source-files";

export type UploadBatchError = "file_required" | "too_many_files" | "forbidden";
export type UploadBatchOutcome = "processing" | "success" | "partial" | "failure";

export type UploadBatchDocument = {
  id: string;
  sourceFileId: string;
  firstPage: number;
  lastPage: number;
  status: DocumentStatus;
};

export type UploadBatchSourceFile = {
  id: string;
  fileName: string;
  status: SourceFileStatus;
  uploadedAt: string;
  documents: UploadBatchDocument[];
};

export type UploadBatchWorkspace = {
  id: string;
  companyId: string;
  plannedFileCount: number;
  actualFileCount: number;
  uploadFinishedAt: string | null;
  processingFinishedAt: string | null;
  createdAt: string;
  outcome: UploadBatchOutcome;
  counts: {
    transport: number;
    waiting: number;
    splitting: number;
    extracting: number;
    review: number;
    reviewed: number;
    failures: number;
    transportFailures: number;
    sourceFailures: number;
    documentFailures: number;
  };
  sourceFiles: UploadBatchSourceFile[];
};

export type UploadBatchSummary = Omit<UploadBatchWorkspace, "sourceFiles">;

export type UploadNotification = {
  id: string;
  batchId: string;
  companyId: string;
  fileCount: number;
  outcome: Exclude<UploadBatchOutcome, "processing">;
  reviewCount: number;
  failureCount: number;
  readAt: string | null;
  createdAt: string;
};

type BatchRow = {
  id: string;
  company_id: string;
  file_count: number;
  upload_finished_at: string | null;
  processing_finished_at: string | null;
  created_at: string;
};

type SourceRow = {
  id: string;
  upload_batch_id: string | null;
  file_name: string;
  status: SourceFileStatus;
  uploaded_at: string;
};

type DocumentRow = {
  id: string;
  source_file_id: string;
  first_page: number;
  last_page: number;
  status: DocumentStatus;
};

const PAGE_SIZE = 1000;

/** Starts one user-selected group of Source Files after enforcing the platform batch limit. */
export async function beginUploadBatch(
  client: AppClient,
  input: { companyId: string; fileCount: number },
): Promise<Result<{ id: string }, UploadBatchError>> {
  const { data, error } = await client.rpc("begin_upload_batch", {
    target_company_id: input.companyId,
    selected_file_count: input.fileCount,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.hint === "file_required" || error.hint === "too_many_files") {
      return { ok: false, error: error.hint };
    }
    throw error;
  }
  return { ok: true, value: { id: data } };
}

/** Marks upload attempts complete; processing completion is detected by database state transitions. */
export async function finishUploadBatch(
  client: AppClient,
  batchId: string,
): Promise<Result<null, "forbidden">> {
  if (!isUuid(batchId)) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("finish_upload_batch", {
    target_batch_id: batchId,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: null };
}

async function sourceRows(client: AppClient, batchIds: string[]): Promise<SourceRow[]> {
  if (!batchIds.length) return [];
  const rows: SourceRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from("source_file")
      .select("id, upload_batch_id, file_name, status, uploaded_at")
      .in("upload_batch_id", batchIds)
      .order("uploaded_at")
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data as SourceRow[]));
    if (data.length < PAGE_SIZE) return rows;
  }
}

async function documentRows(client: AppClient, sourceFileIds: string[]): Promise<DocumentRow[]> {
  const rows: DocumentRow[] = [];
  for (let chunkStart = 0; chunkStart < sourceFileIds.length; chunkStart += 100) {
    const chunk = sourceFileIds.slice(chunkStart, chunkStart + 100);
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await client
        .from("document")
        .select("id, source_file_id, first_page, last_page, status")
        .in("source_file_id", chunk)
        .is("superseded_at", null)
        .order("source_file_id")
        .order("first_page")
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...(data as DocumentRow[]));
      if (data.length < PAGE_SIZE) break;
    }
  }
  return rows;
}

function workspaceOf(
  batch: BatchRow,
  sources: SourceRow[],
  documents: DocumentRow[],
): UploadBatchWorkspace {
  const documentsBySource = new Map<string, UploadBatchDocument[]>();
  for (const document of documents) {
    const group = documentsBySource.get(document.source_file_id) ?? [];
    group.push({
      id: document.id,
      sourceFileId: document.source_file_id,
      firstPage: document.first_page,
      lastPage: document.last_page,
      status: document.status,
    });
    documentsBySource.set(document.source_file_id, group);
  }
  const sourceFiles = sources.map((source) => ({
    id: source.id,
    fileName: source.file_name,
    status: source.status,
    uploadedAt: source.uploaded_at,
    documents: documentsBySource.get(source.id) ?? [],
  }));
  const transportFailures = batch.upload_finished_at
    ? Math.max(batch.file_count - sourceFiles.length, 0)
    : 0;
  const sourceFailures = sourceFiles.filter((source) => source.status === "failed").length;
  const documentFailures = documents.filter((document) => document.status === "failed").length;
  const review = documents.filter((document) => document.status === "needs_review").length;
  const reviewed = documents.filter(
    (document) => document.status === "approved" || document.status === "rejected",
  ).length;
  const failures = transportFailures + sourceFailures + documentFailures;
  const active = !batch.upload_finished_at || sourceFiles.some(
    (source) => source.status === "uploaded" || source.status === "processing",
  ) || documents.some(
    (document) => document.status === "uploaded" || document.status === "processing",
  );
  const outcome: UploadBatchOutcome = active || !batch.processing_finished_at
    ? "processing"
    : failures === 0
      ? "success"
      : review + reviewed > 0
        ? "partial"
        : "failure";

  return {
    id: batch.id,
    companyId: batch.company_id,
    plannedFileCount: batch.file_count,
    actualFileCount: sourceFiles.length,
    uploadFinishedAt: batch.upload_finished_at,
    processingFinishedAt: batch.processing_finished_at,
    createdAt: batch.created_at,
    outcome,
    counts: {
      transport: batch.upload_finished_at ? 0 : Math.max(batch.file_count - sourceFiles.length, 0),
      waiting: sourceFiles.filter((source) => source.status === "uploaded").length
        + documents.filter((document) => document.status === "uploaded").length,
      splitting: sourceFiles.filter((source) => source.status === "processing").length,
      extracting: documents.filter((document) => document.status === "processing").length,
      review,
      reviewed,
      failures,
      transportFailures,
      sourceFailures,
      documentFailures,
    },
    sourceFiles,
  };
}

async function hydrateBatches(
  client: AppClient,
  batches: BatchRow[],
): Promise<UploadBatchWorkspace[]> {
  const sources = await sourceRows(client, batches.map((batch) => batch.id));
  const documents = await documentRows(client, sources.map((source) => source.id));
  return batches.map((batch) => {
    const batchSources = sources.filter((source) => source.upload_batch_id === batch.id);
    const sourceIds = new Set(batchSources.map((source) => source.id));
    return workspaceOf(
      batch,
      batchSources,
      documents.filter((document) => sourceIds.has(document.source_file_id)),
    );
  });
}

/** Persistent upload history for a Company, newest first. */
export async function listUploadBatches(
  client: AppClient,
  companyId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<UploadBatchSummary[]> {
  if (!isUuid(companyId)) return [];
  const limit = Math.max(options.limit ?? 20, 0);
  const offset = Math.max(options.offset ?? 0, 0);
  if (limit === 0) return [];
  const { data, error } = await client
    .from("upload_batch")
    .select("id, company_id, file_count, upload_finished_at, processing_finished_at, created_at")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  const workspaces = await hydrateBatches(client, data as BatchRow[]);
  return workspaces.map((workspace) => {
    return {
      id: workspace.id,
      companyId: workspace.companyId,
      plannedFileCount: workspace.plannedFileCount,
      actualFileCount: workspace.actualFileCount,
      uploadFinishedAt: workspace.uploadFinishedAt,
      processingFinishedAt: workspace.processingFinishedAt,
      createdAt: workspace.createdAt,
      outcome: workspace.outcome,
      counts: workspace.counts,
    };
  });
}

/** One durable batch workspace, or null when it is outside the Company/user scope. */
export async function getUploadBatch(
  client: AppClient,
  companyId: string,
  batchId: string,
): Promise<UploadBatchWorkspace | null> {
  if (!isUuid(companyId) || !isUuid(batchId)) return null;
  const { data, error } = await client
    .from("upload_batch")
    .select("id, company_id, file_count, upload_finished_at, processing_finished_at, created_at")
    .eq("company_id", companyId)
    .eq("id", batchId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (await hydrateBatches(client, [data as BatchRow]))[0];
}

/** Parses stored notification copy conservatively; legacy or corrupt payloads never claim success. */
export function uploadNotificationOutcome(value: unknown): Exclude<UploadBatchOutcome, "processing"> {
  return value === "success" || value === "partial" ? value : "failure";
}

/** Processing-complete upload notifications for the signed-in User, newest first. */
export async function listUploadNotifications(
  client: AppClient,
  companyId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<UploadNotification[]> {
  if (!isUuid(companyId)) return [];
  let query = client
    .from("notification")
    .select("id, company_id, payload, read_at, created_at")
    .eq("company_id", companyId)
    .eq("kind", "upload_batch_finished");
  if (options.unreadOnly) query = query.is("read_at", null);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(options.limit ?? 20);
  if (error) throw error;
  return data.map((row) => {
    const payload = row.payload as Record<string, unknown>;
    return {
      id: row.id,
      batchId: String(payload.batchId ?? ""),
      companyId: row.company_id,
      fileCount: Number(payload.fileCount ?? 0),
      outcome: uploadNotificationOutcome(payload.outcome),
      reviewCount: Number(payload.reviewCount ?? 0),
      failureCount:
        Number(payload.transportFailureCount ?? 0) +
        Number(payload.sourceFailureCount ?? 0) +
        Number(payload.documentFailureCount ?? 0),
      readAt: row.read_at,
      createdAt: row.created_at,
    };
  });
}

/** Marks only the signed-in User's own notification as read. */
export async function markUploadNotificationRead(
  client: AppClient,
  notificationId: string,
): Promise<Result<null, "forbidden">> {
  if (!isUuid(notificationId)) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("mark_upload_notification_read", {
    target_notification_id: notificationId,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: null };
}
