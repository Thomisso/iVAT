import { isUuid, type AppClient, type Result } from "./client";
import { resolveEpoExportDetails, todayInPrague } from "./epo-export-context";
import {
  isEpoFormat,
  parseExportDetails,
  type ExportDetails,
  type EpoFormat,
} from "./epo-export-details";
import { createEpoXml, type EpoXmlError } from "./epo-xml";
import { exportTiming, type ExportTiming } from "./epo-export-timing";
import { getVatReport } from "./vat-reports";
import { isReportingPeriod } from "./vat-rules";
import type { Json } from "@/lib/database.types";

export const EPO_SCHEMA_VERSIONS = {
  dphdp3: "03.01.04",
  dphkh1: "03.01.15",
} as const;
export const EPO_SERIALIZER_VERSION = "2";

export type ExportVatReportError =
  | EpoXmlError
  | "claim_eligibility_unresolved"
  | "report_not_found"
  | "invalid_export_format"
  | "epo_address_required"
  | "forbidden"
  | "stale_report"
  | "report_finalized"
  | "report_not_finalized";
export type EpoDownload = {
  claimEvaluatedOn: string;
  timing: ExportTiming;
  artifactId: string;
  reportGeneratedAt: string;
  periodLockId: string | null;
  xml: string;
  bytes: Uint8Array;
  fileName: string;
  mediaType: "application/xml; charset=utf-8";
};

export type VatReportArtifact = {
  id: string;
  companyId: string;
  vatReportId: string;
  reportGeneratedAt: string;
  periodLockId: string | null;
  period: string;
  format: "dphdp3" | "dphkh1";
  kind: "draft" | "final";
  fileName: string;
  mediaType: "application/xml; charset=utf-8";
  byteSize: number;
  sha256: string;
  resolvedDetails: ExportDetails & { claimEvaluatedOn?: string };
  schemaVersion: string;
  serializerVersion: string;
  authorUserId: string;
  authorEmail: string | null;
  createdAt: string;
};

async function exportVatReportArtifact(
  client: AppClient,
  input: {
    companyId: string;
    period: string;
    format: string;
    details: Record<string, string>;
  },
  kind: "draft" | "final",
  now: () => Date,
): Promise<Result<EpoDownload, ExportVatReportError>> {
  const report = await getVatReport(client, input.companyId, input.period);
  if (!report) return { ok: false, error: "report_not_found" };
  if (!isEpoFormat(input.format))
    return { ok: false, error: "invalid_export_format" };
  const today = todayInPrague(now());
  const resolvedDetails = await resolveEpoExportDetails(client, {
    companyId: input.companyId, company: report.result.company, details: input.details, today,
  });
  if (!resolvedDetails.address) return { ok: false, error: "epo_address_required" };
  const { address, ...fields } = resolvedDetails;
  const details = parseExportDetails(fields, input.format);
  if (!details.ok) return details;
  details.value.address = address;
  const result = await createEpoXml(report.result, input.format, details.value);
  if (!result.ok) return result;
  const bytes = new TextEncoder().encode(result.value);
  const prefix = kind === "draft" ? "DRAFT_" : "";
  const fileName = `${prefix}${input.format.toUpperCase()}_${input.period}.xml`;
  const rpcInput = {
    target_company_id: report.companyId,
    target_vat_report_id: report.id,
    target_report_generated_at: report.generatedAt,
    target_format: input.format,
    target_file_name: fileName,
    target_xml_base64: Buffer.from(bytes).toString("base64"),
    target_resolved_details: details.value as unknown as Json,
    target_schema_version: EPO_SCHEMA_VERSIONS[input.format],
    target_serializer_version: EPO_SERIALIZER_VERSION,
  };
  const stored = kind === "draft"
    ? await client.rpc("create_draft_vat_report_artifact", rpcInput)
    : await client.rpc("create_final_vat_report_artifact", rpcInput);
  if (stored.error) {
    if (stored.error.code === "P0001" && stored.error.hint === "claim_eligibility_unresolved") return { ok: false, error: "claim_eligibility_unresolved" };
    if (stored.error.code === "42501") return { ok: false, error: "forbidden" };
    if (stored.error.code === "P0001" && stored.error.hint === "stale_report")
      return { ok: false, error: "stale_report" };
    if (stored.error.code === "P0001" && stored.error.hint === "report_finalized")
      return { ok: false, error: "report_finalized" };
    if (stored.error.code === "P0001" && stored.error.hint === "report_not_finalized")
      return { ok: false, error: "report_not_finalized" };
    if (stored.error.code === "P0001" && stored.error.hint === "invalid_export_details")
      return { ok: false, error: "invalid_export_details" };
    throw stored.error;
  }
  const artifact = await readVatReportArtifact(client, { companyId: report.companyId, artifactId: stored.data });
  if (!artifact?.artifact.resolvedDetails.claimEvaluatedOn) throw new Error("New XML is missing its trusted claim evaluation date");
  return {
    ok: true,
    value: {
      claimEvaluatedOn: artifact.artifact.resolvedDetails.claimEvaluatedOn,
      timing: exportTiming({ period: input.period, format: input.format, personType: report.result.company.personType, preparedOn: details.value.preparedOn, today }),
      artifactId: stored.data,
      reportGeneratedAt: report.generatedAt,
      periodLockId: kind === "final" ? artifact.artifact.periodLockId : null,
      xml: result.value,
      bytes,
      fileName,
      mediaType: "application/xml; charset=utf-8",
    },
  };
}

/** Saves a validated working XML artifact for an unlocked VAT Report snapshot. */
export function exportVatReport(
  client: AppClient,
  input: {
    companyId: string;
    period: string;
    format: string;
    details: Record<string, string>;
  },
  now: () => Date = () => new Date(),
): Promise<Result<EpoDownload, ExportVatReportError>> {
  return exportVatReportArtifact(client, input, "draft", now);
}

/** Saves a new validated final XML artifact for the actively locked snapshot. */
export function exportFinalVatReport(
  client: AppClient,
  input: {
    companyId: string;
    period: string;
    format: string;
    details: Record<string, string>;
  },
  now: () => Date = () => new Date(),
): Promise<Result<EpoDownload, ExportVatReportError>> {
  return exportVatReportArtifact(client, input, "final", now);
}

/** Every immutable XML artifact for the Reporting Period, newest first. */
export async function listVatReportArtifacts(
  client: AppClient,
  input: { companyId: string; period: string },
): Promise<VatReportArtifact[]> {
  if (!isUuid(input.companyId) || !isReportingPeriod(input.period)) return [];
  const { data, error } = await client.rpc("vat_report_artifact_history", {
    target_company_id: input.companyId,
    target_period: input.period,
  });
  if (error) throw error;
  return data as unknown as VatReportArtifact[];
}

/** Exact stored bytes of one authorized artifact. */
export async function readVatReportArtifact(
  client: AppClient,
  input: { companyId: string; artifactId: string },
): Promise<{ artifact: VatReportArtifact; bytes: Uint8Array } | null> {
  if (!isUuid(input.companyId) || !isUuid(input.artifactId)) return null;
  const { data, error } = await client.rpc("read_vat_report_artifact", {
    target_company_id: input.companyId,
    target_artifact_id: input.artifactId,
  });
  if (error) throw error;
  if (!data) return null;
  const value = data as unknown as { artifact: VatReportArtifact; xmlBase64: string };
  return {
    artifact: value.artifact,
    bytes: new Uint8Array(Buffer.from(value.xmlBase64, "base64")),
  };
}

export type VatReportExportProgress = {
  downloadedFormats: EpoFormat[];
  skippedFormats: EpoFormat[];
};
export type DownloadAcknowledgementInput = {
  companyId: string;
  period: string;
  format: string;
  artifactId: string;
  reportGeneratedAt: string;
  periodLockId?: string | null;
};
export type DownloadAcknowledgementError = "forbidden" | "invalid_download_artifact" | "report_finalized";

function isReportGeneration(value: string): boolean {
  // PostgreSQL timestamps have no year zero, unlike JavaScript's ISO calendar.
  if (value.startsWith("0000-")) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || Number.isNaN(Date.parse(value))) return false;
  const calendarDate = value.slice(0, 10);
  return new Date(`${calendarDate}T00:00:00Z`).toISOString().slice(0, 10) === calendarDate;
}

/** Acknowledges the specific XML only after response receipt and browser download initiation. */
export async function acknowledgeVatReportDownload(
  client: AppClient,
  input: DownloadAcknowledgementInput,
): Promise<Result<null, DownloadAcknowledgementError>> {
  if (!isUuid(input.companyId) || !isUuid(input.artifactId) || !isReportingPeriod(input.period)
    || !isEpoFormat(input.format) || !isReportGeneration(input.reportGeneratedAt)
    || (input.periodLockId != null && !isUuid(input.periodLockId))) {
    return { ok: false, error: "invalid_download_artifact" };
  }
  const { error } = await client.rpc("acknowledge_vat_report_download", {
    target_company_id: input.companyId, target_period: input.period, target_format: input.format,
    target_artifact_id: input.artifactId, target_report_generated_at: input.reportGeneratedAt,
    target_period_lock_id: input.periodLockId ?? undefined,
  });
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error?.code === "P0001" && (error.hint === "invalid_download_artifact" || error.hint === "report_finalized")) {
    return { ok: false, error: error.hint };
  }
  if (error) throw error;
  return { ok: true, value: null };
}

export async function skipVatReportDrafts(
  client: AppClient,
  input: { companyId: string; period: string; reportGeneratedAt: string },
): Promise<Result<null, "forbidden" | "invalid_reporting_period" | "stale_report" | "report_finalized">> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  if (!isReportingPeriod(input.period)) return { ok: false, error: "invalid_reporting_period" };
  if (!isReportGeneration(input.reportGeneratedAt)) return { ok: false, error: "stale_report" };
  const { error } = await client.rpc("skip_vat_report_drafts", {
    target_company_id: input.companyId, target_period: input.period, target_report_generated_at: input.reportGeneratedAt,
  });
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error?.code === "P0001" && (error.hint === "stale_report" || error.hint === "report_finalized")) {
    return { ok: false, error: error.hint };
  }
  if (error) throw error;
  return { ok: true, value: null };
}

/** One database aggregate counts distinct applicable outputs beyond the PostgREST row limit. */
export async function getVatReportExportProgress(
  client: AppClient,
  input: { companyId: string; period: string; reportGeneratedAt: string | null; kind: "draft" | "final"; periodLockId?: string | null },
): Promise<VatReportExportProgress> {
  const empty = { downloadedFormats: [], skippedFormats: [] };
  if (!input.reportGeneratedAt || !isUuid(input.companyId) || !isReportingPeriod(input.period)) return empty;
  const { data, error } = await client.rpc("vat_report_export_progress", {
    target_company_id: input.companyId, target_period: input.period, target_report_generated_at: input.reportGeneratedAt,
    target_kind: input.kind, target_period_lock_id: input.periodLockId ?? undefined,
  });
  if (error) throw error;
  return data ? data as unknown as VatReportExportProgress : empty;
}

export function getVatReportDraftProgress(
  client: AppClient,
  input: { companyId: string; period: string; reportGeneratedAt: string | null },
): Promise<VatReportExportProgress> {
  return getVatReportExportProgress(client, { ...input, kind: "draft" });
}
