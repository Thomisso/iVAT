import { createHash, randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { isUuid, type AppClient, type Result } from "./client";
import type { Company, FilingFrequencyHistoryEntry } from "./companies";
import type { Document, ExtractionVersion } from "./documents";
import { readSourceFile, type SourceFile } from "./source-files";

export type CompanyDataExportDownload = {
  bytes: Uint8Array;
  exportId: string;
  fileName: string;
  mediaType: "application/zip";
};

export type ExportCompanyDataError = "forbidden" | "export_failed" | "stale_export";
export type SoftDeleteCompanyError = "forbidden" | "export_required" | "stale_export";
export type CompanyDeletionReceipt = {
  sourceFileCount: number;
  documentCount: number;
  approvedDocumentCount: number;
  periodLockCount: number;
};

type CompanyExportSnapshot = {
  revision: number;
  company: Company;
  filingFrequencies: FilingFrequencyHistoryEntry[];
  sourceFiles: SourceFile[];
  documents: (Document & { supersededAt: string | null; extractionVersions: ExtractionVersion[] })[];
};

function json(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}

function archiveLeaf(fileName: string): string {
  const leaf = fileName.replaceAll("\\", "/").split("/").at(-1);
  return (leaf || "source-file").replace(/[\u0000-\u001f\u007f]/g, "_");
}

function isMissingStoredObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const storageError = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  return storageError.code === "NoSuchKey"
    || storageError.status === 404
    || storageError.statusCode === "404";
}

/**
 * Produces a complete Company download and records its digest. It does not
 * delete anything; the caller must deliver the bytes before invoking the
 * separately authorized soft-delete command with the returned export id.
 */
export async function exportCompanyData(
  client: AppClient,
  input: { companyId: string },
): Promise<
  Result<CompanyDataExportDownload, ExportCompanyDataError>
> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  const snapshotResult = await client.rpc("company_export_snapshot", { target_company_id: input.companyId });
  if (snapshotResult.error?.code === "42501") return { ok: false, error: "forbidden" };
  if (snapshotResult.error) throw snapshotResult.error;
  const snapshot = snapshotResult.data as unknown as CompanyExportSnapshot;
  const { company, filingFrequencies, sourceFiles, documents } = snapshot;
  const archive: Record<string, Uint8Array> = {
    "company.json": json({ ...company, filingFrequencies }),
    "source-files.json": json(sourceFiles),
    "documents.json": json(documents),
  };
  for (const sourceFile of sourceFiles) {
    let stored;
    try {
      stored = await readSourceFile(client, company.id, sourceFile.id);
    } catch (error) {
      if (isMissingStoredObject(error)) return { ok: false, error: "export_failed" };
      throw error;
    }
    if (!stored) return { ok: false, error: "export_failed" };
    archive[`source-files/${sourceFile.id}/${archiveLeaf(sourceFile.fileName)}`] = stored.bytes;
  }
  const bytes = zipSync(archive, { level: 6 });
  const exportId = randomUUID();
  const fileName = `iVAT-company-${company.ico}-${new Date().toISOString().slice(0, 10)}.zip`;
  const { error } = await client.rpc("record_company_data_export", {
    target_company_id: company.id,
    target_export_id: exportId,
    target_file_name: fileName,
    target_byte_size: bytes.byteLength,
    target_sha256: createHash("sha256").update(bytes).digest("hex"),
    expected_data_revision: snapshot.revision,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.code === "P0001" && error.hint === "stale_export") return { ok: false, error: "stale_export" };
    throw error;
  }
  return {
    ok: true,
    value: { bytes, exportId, fileName, mediaType: "application/zip" },
  };
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
