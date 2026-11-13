import { readPhotoGroupObject } from "./photo-groups";
import { isUuid, type AppClient, type Result } from "./client";
import type { AuditEvent } from "./audit";
import { buildCompanyDataArchive, type CompanyExportSnapshot } from "./company-data-export";
import { SOURCE_FILE_BUCKET, SOURCE_FILE_MEDIA_TYPES, sourceFileObjectPath, type SourceFile } from "./source-files";

export type PlatformCompanyHistory = {
  organizationName: string;
  blocked: boolean;
  deletedAt: string | null;
  snapshot: CompanyExportSnapshot;
  auditEvents: AuditEvent[];
};

/** Retained business history, under the operator's own MFA-verified identity. */
export async function getPlatformCompanyHistory(
  client: AppClient,
  companyId: string,
): Promise<Result<PlatformCompanyHistory, "forbidden">> {
  if (!isUuid(companyId)) return { ok: false, error: "forbidden" };
  const { data, error } = await client.rpc("platform_company_history", { target_company_id: companyId });
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error) throw error;
  return { ok: true, value: data as unknown as PlatformCompanyHistory };
}

async function readOriginal(client: AppClient, file: SourceFile): Promise<Uint8Array> {
  const { data, error } = await client.storage.from(SOURCE_FILE_BUCKET)
    .download(sourceFileObjectPath(file.companyId, file.id, file.storageAttemptId));
  if (error) throw error;
  return new Uint8Array(await data.arrayBuffer());
}

export async function readPlatformCompanySourceFile(
  client: AppClient,
  input: { companyId: string; sourceFileId: string },
): Promise<Result<{ bytes: Uint8Array; fileName: string; mediaType: string }, "forbidden">> {
  const history = await getPlatformCompanyHistory(client, input.companyId);
  if (!history.ok) return history;
  const file = history.value.snapshot.sourceFiles.find((entry) => entry.id === input.sourceFileId);
  if (!file) return { ok: false, error: "forbidden" };
  return { ok: true, value: {
    bytes: await readOriginal(client, file), fileName: file.fileName, mediaType: SOURCE_FILE_MEDIA_TYPES[file.format],
  } };
}

/** A read-only archive does not create the completed export receipt required for deletion. */
export async function downloadPlatformCompanyHistory(
  client: AppClient,
  companyId: string,
): Promise<Result<{ bytes: Uint8Array; fileName: string }, "forbidden">> {
  const history = await getPlatformCompanyHistory(client, companyId);
  if (!history.ok) return history;
  const bytes = await buildCompanyDataArchive(history.value.snapshot, (file) => readOriginal(client, file), path => readPhotoGroupObject(client, path));
  if (!bytes) throw new Error("Retained Company archive could not be assembled");
  return { ok: true, value: { bytes, fileName: `iVAT-history-${history.value.snapshot.company.ico}.zip` } };
}

export async function readPlatformCompanyArtifact(
  client: AppClient,
  input: { companyId: string; artifactId: string },
): Promise<Result<{ bytes: Uint8Array; fileName: string; mediaType: string }, "forbidden">> {
  const history = await getPlatformCompanyHistory(client, input.companyId);
  if (!history.ok) return history;
  const artifact = history.value.snapshot.vatReportArtifacts.find((entry) => entry.id === input.artifactId);
  if (!artifact) return { ok: false, error: "forbidden" };
  return { ok: true, value: {
    bytes: new Uint8Array(Buffer.from(artifact.xmlBase64, "base64")),
    fileName: artifact.fileName, mediaType: artifact.mediaType,
  } };
}
