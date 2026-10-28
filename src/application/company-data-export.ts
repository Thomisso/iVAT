import { strToU8, zipSync } from "fflate";
import type { Company, FilingFrequencyHistoryEntry } from "./companies";
import type { Document, ExtractionVersion } from "./documents";
import type { SourceFile } from "./source-files";

export type CompanyExportSnapshot = {
  revision: number;
  company: Company;
  setupSteps: {
    step: "identity" | "filing_frequency" | "filing_defaults" | "ai_processing";
    state: "completed" | "skipped";
    changedAt: string;
  }[];
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

/** Builds the exact archive delivered by the route and independently verified by the worker. */
export async function buildCompanyDataArchive(
  snapshot: CompanyExportSnapshot,
  readOriginal: (sourceFile: SourceFile) => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  const { company, setupSteps, filingFrequencies, sourceFiles, documents } = snapshot;
  const archive: Record<string, Uint8Array> = {
    "company.json": json({ ...company, setupSteps, filingFrequencies }),
    "source-files.json": json(sourceFiles),
    "documents.json": json(documents),
  };
  for (const sourceFile of sourceFiles) {
    const bytes = await readOriginal(sourceFile);
    if (!bytes) return null;
    archive[`source-files/${sourceFile.id}/${archiveLeaf(sourceFile.fileName)}`] = bytes;
  }
  // ZIP timestamps are fixed so independent route/worker builds have the same digest.
  return zipSync(archive, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") });
}
