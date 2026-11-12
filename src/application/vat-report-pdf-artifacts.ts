import { isUuid, type AppClient, type Result } from "./client";
import type { ExportDetails, EpoFormat } from "./epo-export-details";
import { EPO_SCHEMA_VERSIONS, EPO_SERIALIZER_VERSION, type VatReportArtifact } from "./epo-export";
import { isReportingPeriod } from "./vat-rules";
import type { Json, Tables } from "@/lib/database.types";

export type PdfArtifactError = "forbidden" | "stale_report" | "invalid_export_details";
export type VatReportPdfArtifact = Omit<VatReportArtifact, "mediaType"> & { mediaType: "application/pdf" };
type PdfRow = Omit<Tables<"vat_report_pdf_artifact">, "pdf_bytes">;
function metadata(row: PdfRow): VatReportPdfArtifact {
  return { id: row.id, companyId: row.company_id, vatReportId: row.vat_report_id,
    reportGeneratedAt: row.report_generated_at, periodLockId: row.period_lock_id,
    period: row.period, format: row.format as EpoFormat, kind: row.kind as "draft" | "final",
    fileName: row.file_name, mediaType: "application/pdf", byteSize: row.byte_size!, sha256: row.sha256!,
    resolvedDetails: row.resolved_details as unknown as ExportDetails, schemaVersion: row.schema_version,
    serializerVersion: row.serializer_version, authorUserId: row.created_by, authorEmail: null, createdAt: row.created_at };
}
/** Archives complete PDF downloads, including review exports with incomplete filing fields. */
export async function archiveVatReportPdf(client: AppClient, input: {
  companyId: string; reportId: string; reportGeneratedAt: string; format: EpoFormat;
  bytes: Uint8Array; details: ExportDetails;
}): Promise<Result<string, PdfArtifactError>> {
  const { data, error } = await client.rpc("create_vat_report_pdf_artifact", {
    target_company_id: input.companyId, target_vat_report_id: input.reportId,
    target_report_generated_at: input.reportGeneratedAt, target_format: input.format,
    target_pdf_base64: Buffer.from(input.bytes).toString("base64"), target_resolved_details: input.details as unknown as Json,
    target_schema_version: EPO_SCHEMA_VERSIONS[input.format], target_serializer_version: EPO_SERIALIZER_VERSION,
  });
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error?.code === "P0001" && error.hint === "stale_report") return { ok: false, error: "stale_report" };
  if (error?.code === "P0001" && error.hint === "invalid_export_details") return { ok: false, error: "invalid_export_details" };
  if (error) throw error;
  return { ok: true, value: data };
}
export async function readVatReportPdfArtifact(client: AppClient, input: { companyId: string; artifactId: string }): Promise<{ artifact: VatReportPdfArtifact; bytes: Uint8Array } | null> {
  if (!isUuid(input.companyId) || !isUuid(input.artifactId)) return null;
  const { data, error } = await client.rpc("read_vat_report_pdf_artifact", { target_company_id: input.companyId, target_artifact_id: input.artifactId });
  if (error) throw error;
  if (!data) return null;
  const value = data as unknown as { artifact: PdfRow; pdfBase64: string };
  return { artifact: metadata(value.artifact), bytes: new Uint8Array(Buffer.from(value.pdfBase64, "base64")) };
}
/** Page through all metadata; PDF bytes are read only for an individual download. */
export async function listVatReportPdfArtifacts(client: AppClient, input: { companyId: string; period: string }): Promise<VatReportPdfArtifact[]> {
  if (!isUuid(input.companyId) || !isReportingPeriod(input.period)) return [];
  const artifacts: VatReportPdfArtifact[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client.from("vat_report_pdf_artifact")
      .select("id, organization_id, company_id, vat_report_id, report_generated_at, period_lock_id, period, format, kind, file_name, media_type, byte_size, sha256, resolved_details, schema_version, serializer_version, created_by, created_at")
      .eq("company_id", input.companyId).eq("period", input.period)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 499);
    if (error) throw error;
    artifacts.push(...data.map(metadata));
    if (data.length < 500) return artifacts;
  }
}
