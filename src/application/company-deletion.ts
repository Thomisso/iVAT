import { isUuid, type AppClient, type Result } from "./client";
import { buildCompanyDataArchive, type CompanyExportSnapshot } from "./company-data-export";
import { completeCompanyExportJob, type JobQueue } from "./processing";
import { readSourceFile } from "./source-files";
import type { CompanyDataExportStatus } from "@/lib/company-data-export-status";

export type CompanyDataExportDownload = {
  bytes: Uint8Array;
  exportId: string;
  fileName: string;
  mediaType: "application/zip";
};

export type ExportCompanyDataError = "forbidden" | "export_failed";
export type SoftDeleteCompanyError = "forbidden" | "export_required" | "stale_export";
export type CompanyDeletionReceipt = {
  sourceFileCount: number;
  documentCount: number;
  approvedDocumentCount: number;
  periodLockCount: number;
};

type PendingCompanyExport = {
  exportId: string;
  fileName: string;
  snapshot: CompanyExportSnapshot;
};

function isMissingStoredObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const storageError = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  return storageError.code === "NoSuchKey"
    || storageError.status === 404
    || storageError.statusCode === "404";
}

/**
 * Produces a complete Company download and enqueues independent worker
 * verification. It does not delete anything; the caller must deliver the bytes
 * before invoking the separately authorized soft-delete command.
 */
export async function exportCompanyData(
  client: AppClient,
  jobs: JobQueue,
  input: { companyId: string },
): Promise<
  Result<CompanyDataExportDownload, ExportCompanyDataError>
> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  const started = await client.rpc("create_company_data_export", { target_company_id: input.companyId });
  if (started.error?.code === "42501") return { ok: false, error: "forbidden" };
  if (started.error) throw started.error;
  const pending = started.data as unknown as PendingCompanyExport;
  let bytes: Uint8Array | null;
  try {
    bytes = await buildCompanyDataArchive(pending.snapshot, async (sourceFile) => (
      await readSourceFile(client, pending.snapshot.company.id, sourceFile.id)
    )?.bytes ?? null);
  } catch (error) {
    if (isMissingStoredObject(error)) return { ok: false, error: "export_failed" };
    throw error;
  }
  if (!bytes) return { ok: false, error: "export_failed" };
  await jobs.send(completeCompanyExportJob(pending.exportId));
  return {
    ok: true,
    value: { bytes, exportId: pending.exportId, fileName: pending.fileName, mediaType: "application/zip" },
  };
}

/** Whether the current Administrator's downloaded export can authorize deletion. */
export async function getCompanyDataExportStatus(
  client: AppClient,
  input: { companyId: string; exportId: string },
): Promise<Result<CompanyDataExportStatus, "forbidden">> {
  if (!isUuid(input.companyId) || !isUuid(input.exportId)) {
    return { ok: false, error: "forbidden" };
  }
  const { data, error } = await client.rpc("company_data_export_status", {
    target_company_id: input.companyId,
    target_export_id: input.exportId,
  });
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error) throw error;
  return { ok: true, value: data as CompanyDataExportStatus };
}

/** Soft-deletes a Company only with the current Administrator's completed export. */
export async function softDeleteCompany(
  client: AppClient,
  input: { companyId: string; exportId: string },
): Promise<Result<CompanyDeletionReceipt, SoftDeleteCompanyError>> {
  if (!isUuid(input.companyId) || !isUuid(input.exportId)) {
    return { ok: false, error: "export_required" };
  }
  const { data, error } = await client.rpc("soft_delete_company", {
    target_company_id: input.companyId,
    target_export_id: input.exportId,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.code === "P0001" && error.hint === "export_required") {
      return { ok: false, error: "export_required" };
    }
    if (error.code === "P0001" && error.hint === "stale_export") {
      return { ok: false, error: "stale_export" };
    }
    throw error;
  }
  return { ok: true, value: data as unknown as CompanyDeletionReceipt };
}
