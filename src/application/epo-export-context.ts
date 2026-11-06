import type { AppClient, Result } from "./client";
import { getCompanyFilingDefaults, resolveEpoAddress } from "./company-filing-defaults";
import type { ExportDetails } from "./epo-export-details";
import type { ComputedVatReport } from "./vat-rules";
import { getVatReport } from "./vat-reports";

export type VatReportExportHeader = {
  company: ComputedVatReport["company"];
  period: string;
  details: ExportDetails;
};

export function todayInPrague(now: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(now);
}

/** Resolve available filing details without requiring XML completeness. Explicit
 * empty optional fields override defaults; identity always comes from the report. */
export async function resolveEpoExportDetails(
  client: AppClient,
  input: {
    companyId: string;
    company: ComputedVatReport["company"];
    details: Record<string, string>;
    today: string;
  },
): Promise<ExportDetails> {
  const defaults = await getCompanyFilingDefaults(client, input.companyId);
  const address = resolveEpoAddress(input.company, defaults);
  const supplied = (key: string, fallback: string | null | undefined) =>
    (Object.hasOwn(input.details, key) ? input.details[key] : (fallback ?? "")).trim();
  const taxOffice = supplied("taxOffice", defaults?.taxOffice);
  const common = {
    taxOffice,
    territorialOffice: taxOffice === "13" ? "4000" : supplied("territorialOffice", defaults?.territorialOffice),
    economicActivity: supplied("economicActivity", defaults?.economicActivity),
    preparedOn: input.details.preparedOn?.trim() || input.today,
    email: supplied("email", defaults?.email),
    phone: supplied("phone", defaults?.phone),
    address: address.ok ? address.value.address : undefined,
  };
  return input.company.personType === "natural"
    ? { ...common, personType: "F" }
    : {
      ...common, personType: "P",
      signatoryFirstName: supplied("signatoryFirstName", defaults?.signatoryFirstName),
      signatoryLastName: supplied("signatoryLastName", defaults?.signatoryLastName),
      signatoryCapacity: supplied("signatoryCapacity", defaults?.signatoryCapacity),
    };
}

/** Header-only preparation for previews. Reads the authorized saved report and
 * current defaults, without computing a report or generating any PDF/XML. */
export async function getVatReportExportHeader(
  client: AppClient,
  input: { companyId: string; period: string; details?: Record<string, string> },
  now: () => Date = () => new Date(),
): Promise<Result<VatReportExportHeader, "report_not_found">> {
  const report = await getVatReport(client, input.companyId, input.period);
  if (!report) return { ok: false, error: "report_not_found" };
  return { ok: true, value: {
    company: report.result.company,
    period: report.period,
    details: await resolveEpoExportDetails(client, {
      companyId: input.companyId, company: report.result.company,
      details: input.details ?? {}, today: todayInPrague(now()),
    }),
  } };
}
