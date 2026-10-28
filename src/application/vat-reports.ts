import { isUuid, type AppClient, type Result } from "./client";
import { getCompany, type CompanyDetails } from "./companies";
import {
  computeVatReport,
  isReportingPeriod,
  type ComputedVatReport,
  type ReportDocument,
} from "./vat-rules";
import type { Json } from "@/lib/database.types";

export type VatReport = {
  id: string;
  companyId: string;
  period: string;
  generatedAt: string;
  result: ComputedVatReport;
  documents: ReportDocument[];
};
export type GenerateVatReportError =
  "forbidden" | "invalid_reporting_period" | "stale_report";

/** Generates or replaces a monthly draft from the current, human-reviewed data. */
export async function generateVatReport(
  client: AppClient,
  input: { companyId: string; period: string },
): Promise<Result<{ id: string }, GenerateVatReportError>> {
  if (!isReportingPeriod(input.period))
    return { ok: false, error: "invalid_reporting_period" };
  const company = await getCompany(client, input.companyId);
  if (!company) return { ok: false, error: "forbidden" };
  const { data, error } = await client.rpc("vat_report_documents", {
    target_company_id: company.id,
    target_period: input.period,
  });
  if (error) throw error;
  const documents = data as unknown as ReportDocument[];
  const details: CompanyDetails = {
    name: company.name,
    ico: company.ico,
    vatId: company.vatId,
    street: company.street,
    city: company.city,
    postalCode: company.postalCode,
    personType: company.personType,
  };
  const result = computeVatReport(details, input.period, documents);
  const saved = await client.rpc("save_vat_report", {
    target_company_id: company.id,
    target_period: input.period,
    expected_documents: documents as unknown as Json,
    computed_result: result as unknown as Json,
  });
  if (saved.error) {
    if (saved.error.code === "42501") return { ok: false, error: "forbidden" };
    if (saved.error.code === "P0001" && saved.error.hint === "stale_report")
      return { ok: false, error: "stale_report" };
    throw saved.error;
  }
  return { ok: true, value: { id: saved.data } };
}

/** Reads the saved snapshot, without recomputing it from subsequently changed Documents. */
export async function getVatReport(
  client: AppClient,
  companyId: string,
  period: string,
): Promise<VatReport | null> {
  if (!isUuid(companyId) || !isReportingPeriod(period)) return null;
  const { data, error } = await client
    .from("vat_report")
    .select("id, company_id, period, generated_at, result, documents")
    .eq("company_id", companyId)
    .eq("period", period)
    .maybeSingle();
  if (error) throw error;
  return data
    ? {
        id: data.id,
        companyId: data.company_id,
        period: data.period,
        generatedAt: data.generated_at,
        result: data.result as unknown as ComputedVatReport,
        documents: data.documents as unknown as ReportDocument[],
      }
    : null;
}
