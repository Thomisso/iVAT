import { isUuid, type AppClient, type Result } from "./client";
import { getCompanyFilingDefaults, resolveEpoAddress } from "./company-filing-defaults";
import {
  isEpoFormat,
  parseExportDetails,
  type ExportDetails,
  type EpoFormat,
} from "./epo-export-details";
import { createEpoXml, type EpoXmlError } from "./epo-xml";
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
  | "report_not_found"
  | "invalid_export_format"
  | "epo_address_required"
  | "forbidden"
  | "stale_report"
  | "report_finalized"
  | "report_not_finalized";
export type EpoDownload = {
  artifactId: string;
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
  period: string;
  format: "dphdp3" | "dphkh1";
  kind: "draft" | "final";
  fileName: string;
  mediaType: "application/xml; charset=utf-8";
  byteSize: number;
  sha256: string;
  resolvedDetails: ExportDetails;
  schemaVersion: string;
  serializerVersion: string;
  authorUserId: string;
  authorEmail: string | null;
  createdAt: string;
};

function todayInPrague(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());
}

async function resolveExportDetails(
  client: AppClient,
  input: {
    companyId: string;
    details: Record<string, string>;
    format: EpoFormat;
    personType: "legal" | "natural";
    registeredAddress: NonNullable<ExportDetails["address"]>;
  },
): Promise<Result<ExportDetails, "invalid_export_details" | "epo_address_required">> {
  const defaults = await getCompanyFilingDefaults(client, input.companyId);
  const resolvedAddress = resolveEpoAddress(input.registeredAddress, defaults);
  if (!resolvedAddress.ok) return resolvedAddress;
  const supplied = (key: string, fallback: string | null | undefined) =>
    Object.hasOwn(input.details, key) ? input.details[key] : (fallback ?? "");
  const parsed = parseExportDetails({
    taxOffice: supplied("taxOffice", defaults?.taxOffice),
    territorialOffice: supplied("territorialOffice", defaults?.territorialOffice),
    economicActivity: supplied("economicActivity", defaults?.economicActivity),
    preparedOn: input.details.preparedOn?.trim() || todayInPrague(),
    email: supplied("email", defaults?.email),
    phone: supplied("phone", defaults?.phone),
    personType: input.personType === "natural" ? "F" : "P",
    signatoryFirstName: supplied("signatoryFirstName", defaults?.signatoryFirstName),
    signatoryLastName: supplied("signatoryLastName", defaults?.signatoryLastName),
    signatoryCapacity: supplied("signatoryCapacity", defaults?.signatoryCapacity),
  }, input.format);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      ...parsed.value,
      address: resolvedAddress.value.address,
    },
  };
}

async function exportVatReportArtifact(
  client: AppClient,
  input: {
    companyId: string;
    period: string;
    format: string;
    details: Record<string, string>;
  },
  kind: "draft" | "final",
): Promise<Result<EpoDownload, ExportVatReportError>> {
  const report = await getVatReport(client, input.companyId, input.period);
  if (!report) return { ok: false, error: "report_not_found" };
  if (!isEpoFormat(input.format))
    return { ok: false, error: "invalid_export_format" };
  const details = await resolveExportDetails(client, {
    companyId: input.companyId,
    details: input.details,
    format: input.format,
    personType: report.result.company.personType,
    registeredAddress: {
      streetName: report.result.company.streetName,
      houseNumber: report.result.company.houseNumber,
      orientationNumber: report.result.company.orientationNumber,
      city: report.result.company.city,
      postalCode: report.result.company.postalCode,
    },
  });
  if (!details.ok) return details;
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
  return {
    ok: true,
    value: {
      artifactId: stored.data,
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
): Promise<Result<EpoDownload, ExportVatReportError>> {
  return exportVatReportArtifact(client, input, "draft");
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
): Promise<Result<EpoDownload, ExportVatReportError>> {
  return exportVatReportArtifact(client, input, "final");
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
