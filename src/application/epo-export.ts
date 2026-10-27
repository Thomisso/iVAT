import type { AppClient, Result } from "./client";
import { isEpoFormat, parseExportDetails } from "./epo-export-details";
import { createEpoXml, type EpoXmlError } from "./epo-xml";
import { getVatReport } from "./vat-reports";

export type ExportVatReportError =
  EpoXmlError | "report_not_found" | "invalid_export_format";
export type EpoDownload = {
  xml: string;
  fileName: string;
  mediaType: "application/xml; charset=utf-8";
};

/** RLS scopes the saved draft; only a validated XML candidate becomes a download. */
export async function exportVatReport(
  client: AppClient,
  input: {
    companyId: string;
    period: string;
    format: string;
    details: Record<string, string>;
  },
): Promise<Result<EpoDownload, ExportVatReportError>> {
  const report = await getVatReport(client, input.companyId, input.period);
  if (!report) return { ok: false, error: "report_not_found" };
  if (!isEpoFormat(input.format))
    return { ok: false, error: "invalid_export_format" };
  const details = parseExportDetails({
    ...input.details,
    personType: report.result.company.personType === "natural" ? "F" : "P",
  });
  if (!details.ok) return details;
  const result = await createEpoXml(report.result, input.format, details.value);
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      xml: result.value,
      fileName: `${input.format.toUpperCase()}-${input.period}.xml`,
      mediaType: "application/xml; charset=utf-8",
    },
  };
}
