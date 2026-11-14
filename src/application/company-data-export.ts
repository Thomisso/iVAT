import { photoGroupPath, type PhotoGroup } from "./photo-groups";
import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import type { Counterparty } from "./counterparties";
import type { Company, ReportingYear } from "./companies";
import type { CompanyFilingDefaults } from "./company-filing-defaults";
import type { Document, ExtractionVersion } from "./documents";
import type { VatReportArtifact } from "./epo-export";
import type { VatReportPdfArtifact } from "./vat-report-pdf-artifacts";
import { sourceFileDerivativeObjectPath, type SourceFile } from "./source-files";
import type { VatReport, VatReportTransition } from "./vat-reports";

export type CompanyExportSnapshot = {
  revision: number;
  company: Company & { filingDefaults: CompanyFilingDefaults | null };
  setupSteps: {
    step: "identity" | "filing_frequency" | "filing_defaults" | "ai_processing";
    state: "completed" | "skipped";
    changedAt: string;
  }[];
  reportingYears: ReportingYear[];
  counterparties?: (Counterparty & { createdAt: string })[];
  sourceFiles: SourceFile[];
  photoGroups?: PhotoGroup[];
  documents: (Document & { supersededAt: string | null; extractionVersions: ExtractionVersion[] })[];
  vatReports: (VatReport & { generatedBy: string })[];
  vatReportTransitions: VatReportTransition[];
  vatReportArtifacts: (VatReportArtifact & { xmlBase64: string })[];
  vatReportPdfArtifacts?: (VatReportPdfArtifact & { pdfBase64: string })[];
  vatReportDownloadAcknowledgements?: { artifactId: string; periodLockId?: string | null; acknowledgedAt: string; acknowledgedBy: string }[];
  vatReportDraftSkips?: { id: string; vatReportId: string; reportGeneratedAt: string; skippedFormats: string[]; skippedAt: string; skippedBy: string }[];
};

function json(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}

function archiveLeaf(fileName: string): string {
  const leaf = fileName.replaceAll("\\", "/").split("/").at(-1);
  return (leaf || "source-file").replace(/[\u0000-\u001f\u007f]/g, "_");
}

/** Builds the exact archive delivered by the route and independently verified by the worker. */
export async function buildCompanyDataArchive(
  snapshot: CompanyExportSnapshot,
  readOriginal: (sourceFile: SourceFile) => Promise<Uint8Array | null>,
  readObject?: (path: string) => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  const {
    company,
    setupSteps,
    reportingYears,
    sourceFiles,
    documents,
    vatReports,
    vatReportTransitions,
    vatReportArtifacts,
  } = snapshot;
  const artifactMetadata = vatReportArtifacts.map(({ xmlBase64, ...artifact }) => {
    void xmlBase64;
    return artifact;
  });
  const pdfArtifactMetadata = snapshot.vatReportPdfArtifacts?.map(({ pdfBase64, ...artifact }) => {
    void pdfBase64;
    return artifact;
  });
  const archive: Record<string, Uint8Array> = {
    "company.json": json({ ...company, setupSteps, reportingYears }),
    "source-files.json": json(sourceFiles),
    "documents.json": json(documents),
    ...(snapshot.counterparties ? { "counterparties.json": json(snapshot.counterparties) } : {}),
    "vat-reports.json": json(vatReports),
    "vat-report-transitions.json": json(vatReportTransitions),
    "vat-report-artifacts.json": json(artifactMetadata),
    ...(pdfArtifactMetadata ? { "vat-report-pdf-artifacts.json": json(pdfArtifactMetadata) } : {}),
    ...(snapshot.vatReportDownloadAcknowledgements ? {
      "vat-report-download-acknowledgements.json": json(snapshot.vatReportDownloadAcknowledgements),
    } : {}),
    ...(snapshot.vatReportDraftSkips ? {
      "vat-report-draft-skips.json": json(snapshot.vatReportDraftSkips),
    } : {}),
  };
  for (const sourceFile of sourceFiles) {
    const bytes = await readOriginal(sourceFile);
    if (!bytes) return null;
    archive[`source-files/${sourceFile.id}/${archiveLeaf(sourceFile.fileName)}`] = bytes;
  }
  if (snapshot.photoGroups) archive["photo-groups.json"] = json(snapshot.photoGroups);
  for (const group of snapshot.photoGroups ?? []) {
    archive[`photo-groups/${group.id}/manifest.json`] = json(group);
    if (!group.basis) continue;
    if (!readObject) return null;
    // Only new manifests require these intermediate objects. Historical
    // manifests keep their exact archive bytes and are never regenerated.
    for (const page of group.basis.pages) {
      if (!page.normalizedDerivative) continue;
      const source = sourceFiles.find(source => source.id === page.sourceFileId);
      const derivative = page.normalizedDerivative;
      if (!source || source.sha256 !== page.sourceSha256 || source.normalizedDerivative?.sha256 !== derivative.sha256
        || source.normalizedDerivative.byteSize !== derivative.byteSize || source.normalizedDerivative.format !== derivative.format) return null;
      const bytes = await readObject(sourceFileDerivativeObjectPath(company.id, source.id, source.storageAttemptId));
      if (!bytes || bytes.length !== derivative.byteSize || createHash("sha256").update(bytes).digest("hex") !== derivative.sha256) return null;
      archive[`source-files/${source.id}/normalized.jpeg`] = bytes;
    }
    for (const object of [{ leaf: "basis.pdf", ...group.basis }, ...group.basis.pages.map(page => ({ ...page, leaf: `${page.page}.png` }))]) {
      const bytes = await readObject(photoGroupPath(group, object.leaf));
      if (!bytes || bytes.length !== object.byteSize || createHash("sha256").update(bytes).digest("hex") !== object.sha256) return null;
      archive[`photo-groups/${group.id}/${object.leaf}`] = bytes;
    }
  }
  for (const artifact of vatReportArtifacts) {
    const bytes = new Uint8Array(Buffer.from(artifact.xmlBase64, "base64"));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== artifact.byteSize || sha256 !== artifact.sha256) return null;
    archive[`vat-report-artifacts/${artifact.id}/${archiveLeaf(artifact.fileName)}`] = bytes;
  }
  for (const artifact of snapshot.vatReportPdfArtifacts ?? []) {
    const bytes = new Uint8Array(Buffer.from(artifact.pdfBase64, "base64"));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== artifact.byteSize || sha256 !== artifact.sha256) return null;
    archive[`vat-report-pdf-artifacts/${artifact.id}/${archiveLeaf(artifact.fileName)}`] = bytes;
  }
  // ZIP timestamps are fixed so independent route/worker builds have the same digest.
  return zipSync(archive, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") });
}
