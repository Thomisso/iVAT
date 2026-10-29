import type { AppClient, Result } from "./client";
import { getCompanyFilingDefaults } from "./company-filing-defaults";
import {
  isEpoFormat,
  parseExportDetails,
  type ExportDetails,
} from "./epo-export-details";
import { createEpoXml, type EpoXmlError } from "./epo-xml";
import { getVatReport } from "./vat-reports";

export type ExportVatReportError =
  EpoXmlError | "report_not_found" | "invalid_export_format";
export type EpoDownload = {
  xml: string;
  fileName: string;
  mediaType: "application/xml; charset=utf-8";
};

function todayInPrague(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());
}

async function resolveExportDetails(
  client: AppClient,
  input: {
    companyId: string;
    details: Record<string, string>;
    personType: "legal" | "natural";
    registeredAddress: NonNullable<ExportDetails["address"]>;
  },
): Promise<Result<ExportDetails, "invalid_export_details">> {
  const defaults = await getCompanyFilingDefaults(client, input.companyId);
  const supplied = (key: string, fallback: string | null | undefined) =>
    Object.hasOwn(input.details, key) ? input.details[key] : (fallback ?? "");
  const parsed = parseExportDetails({
    taxOffice: supplied("taxOffice", defaults?.taxOffice),
    preparedOn: input.details.preparedOn?.trim() || todayInPrague(),
    email: supplied("email", defaults?.email),
    phone: supplied("phone", defaults?.phone),
    personType: input.personType === "natural" ? "F" : "P",
    signatoryFirstName: supplied("signatoryFirstName", defaults?.signatoryFirstName),
    signatoryLastName: supplied("signatoryLastName", defaults?.signatoryLastName),
    signatoryCapacity: supplied("signatoryCapacity", defaults?.signatoryCapacity),
  });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      ...parsed.value,
      address: defaults?.epoAddressOverride ?? input.registeredAddress,
    },
  };
}

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
  const details = await resolveExportDetails(client, {
    companyId: input.companyId,
    details: input.details,
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
  return {
    ok: true,
    value: {
      xml: result.value,
      fileName: `${input.format.toUpperCase()}-${input.period}.xml`,
      mediaType: "application/xml; charset=utf-8",
    },
  };
}
