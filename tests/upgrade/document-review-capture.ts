import { createHash } from "node:crypto";
import type { AppClient } from "@/application/client";
import { getDocument, listExtractionVersions } from "@/application/documents";
import { getVatReport, getPeriodLock, listVatReportTransitions } from "@/application/vat-reports";
import { listVatReportArtifacts, readVatReportArtifact } from "@/application/epo-export";
import { getSourceFile, readSourceFile } from "@/application/source-files";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";

export type LegacyCompany = {
  companyId: string; userId: string; email: string; documentIds: string[];
  period: string; sourceFileId?: string;
};

/** Stable hashes supplement full public Version comparisons; object key order is irrelevant. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Capture only public observations under the real User identity. */
export async function captureLegacy(client: AppClient, company: LegacyCompany) {
  const documents = [];
  for (const id of company.documentIds) {
    const versions = await listExtractionVersions(client, company.companyId, id);
    documents.push({ document: await getDocument(client, company.companyId, id),
      versions, versionSha256: sha256(canonical(versions)) });
  }
  const artifacts = [];
  for (const artifact of await listVatReportArtifacts(client, { companyId: company.companyId, period: company.period })) {
    const downloaded = await readVatReportArtifact(client, { companyId: company.companyId, artifactId: artifact.id });
    if (!downloaded) throw new Error("Legacy artifact is unreadable");
    artifacts.push({ metadata: artifact, downloadedMetadata: downloaded.artifact,
      base64: Buffer.from(downloaded.bytes).toString("base64"), sha256: sha256(downloaded.bytes) });
  }
  const source = company.sourceFileId ? await getSourceFile(client, company.companyId, company.sourceFileId) : null;
  const original = company.sourceFileId ? await readSourceFile(client, company.companyId, company.sourceFileId) : null;
  return { documents, report: await getVatReport(client, company.companyId, company.period),
    lock: await getPeriodLock(client, company.companyId, company.period),
    transitions: await listVatReportTransitions(client, company.companyId, company.period), artifacts,
    source, originalBase64: original ? Buffer.from(original.bytes).toString("base64") : null,
    allowance: await getCompanyAiProcessingAllowance(client, company.companyId) };
}
export type LegacyCapture = Awaited<ReturnType<typeof captureLegacy>>;
export type UpgradeManifest = { companies: { identity: LegacyCompany; before: LegacyCapture }[] };
