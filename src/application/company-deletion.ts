import { createHash, randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { isUuid, type AppClient, type Result } from "./client";
import {
  getCompany,
  getMyCompanyRole,
  listCompanyFilingFrequencies,
} from "./companies";
import { listDocuments, listExtractionVersions } from "./documents";
import { listSourceFiles, readSourceFile } from "./source-files";

export type CompanyDataExportDownload = {
  bytes: Uint8Array;
  exportId: string;
  fileName: string;
  mediaType: "application/zip";
};

export type ExportCompanyDataError = "forbidden" | "export_failed";
export type SoftDeleteCompanyError = "forbidden" | "export_required";

function json(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}

function archiveLeaf(fileName: string): string {
  const leaf = fileName.replaceAll("\\", "/").split("/").at(-1);
  return (leaf || "source-file").replace(/[\u0000-\u001f\u007f]/g, "_");
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
  const [company, role] = await Promise.all([
    getCompany(client, input.companyId),
    getMyCompanyRole(client, input.companyId),
  ]);
  if (!company || role !== "administrator") {
    return { ok: false, error: "forbidden" };
  }

  try {
    const [filingFrequencies, sourceFiles] = await Promise.all([
      listCompanyFilingFrequencies(client, company.id),
      listSourceFiles(client, company.id),
    ]);
    const archive: Record<string, Uint8Array> = {
      "company.json": json({ ...company, filingFrequencies }),
      "source-files.json": json(sourceFiles),
    };
    const documents = [];
    for (const sourceFile of sourceFiles) {
      const stored = await readSourceFile(client, company.id, sourceFile.id);
      if (!stored) return { ok: false, error: "export_failed" };
      archive[
        `source-files/${sourceFile.id}/${archiveLeaf(sourceFile.fileName)}`
      ] = stored.bytes;
      for (const document of await listDocuments(
        client,
        company.id,
        sourceFile.id,
      )) {
        documents.push({
          ...document,
          extractionVersions: await listExtractionVersions(
            client,
            company.id,
            document.id,
          ),
        });
      }
    }
    archive["documents.json"] = json(documents);
    const bytes = zipSync(archive, { level: 6 });
    const exportId = randomUUID();
    const fileName = `iVAT-company-${company.ico}-${new Date().toISOString().slice(0, 10)}.zip`;
    const { error } = await client.rpc("record_company_data_export", {
      target_company_id: company.id,
      target_export_id: exportId,
      target_file_name: fileName,
      target_byte_size: bytes.byteLength,
      target_sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    if (error) {
      if (error.code === "42501") return { ok: false, error: "forbidden" };
      throw error;
    }
    return {
      ok: true,
      value: {
        bytes,
        exportId,
        fileName,
        mediaType: "application/zip",
      },
    };
  } catch {
    return { ok: false, error: "export_failed" };
  }
}

/** Soft-deletes a Company only with the current Administrator's completed export. */
export async function softDeleteCompany(
  client: AppClient,
  input: { companyId: string; exportId: string },
): Promise<Result<null, SoftDeleteCompanyError>> {
  if (!isUuid(input.companyId) || !isUuid(input.exportId)) {
    return { ok: false, error: "export_required" };
  }
  const { error } = await client.rpc("soft_delete_company", {
    target_company_id: input.companyId,
    target_export_id: input.exportId,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.code === "P0001" && error.hint === "export_required") {
      return { ok: false, error: "export_required" };
    }
    throw error;
  }
  return { ok: true, value: null };
}
