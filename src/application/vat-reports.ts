import { isUuid, type AppClient, type Result } from "./client";
import {
  getCompany,
  getCompanySetupChecklist,
  getFilingFrequencyForPeriod,
  listCompanyFilingFrequencies,
  type CompanyDetails,
} from "./companies";
import {
  computeVatReport,
  isReportingPeriod,
  type ComputedVatReport,
  type ReportDocument,
} from "./vat-rules";
import type { Json } from "@/lib/database.types";
import {
  getReportingPeriodReadiness,
  type ReportingPeriodReadinessSource,
} from "./reporting-period-readiness";

export type VatReport = {
  id: string;
  companyId: string;
  period: string;
  generatedAt: string;
  result: ComputedVatReport & {
    readinessSource?: ReportingPeriodReadinessSource[];
  };
  documents: ReportDocument[];
};
export type GenerateVatReportError =
  "forbidden" | "company_setup_incomplete" | "invalid_reporting_period" | "stale_report" | "period_locked";

export type PeriodLock = {
  companyId: string;
  period: string;
  vatReportId: string;
  lockedBy: string;
  lockedAt: string;
};

export type FinalizeVatReportError =
  | "forbidden"
  | "invalid_reporting_period"
  | "report_not_found";
export type UnlockReportingPeriodError =
  | "forbidden"
  | "invalid_reporting_period"
  | "not_locked";

function periodTransitionRefusal<E extends string>(
  error: { code?: string; hint?: string },
  codes: E[],
): Result<never, E | "forbidden"> {
  if (error.code === "42501") return { ok: false, error: "forbidden" };
  const code = codes.find((candidate) => candidate === error.hint);
  if (code) return { ok: false, error: code };
  throw error;
}

/** Finalizes the stored VAT Report and locks its Reporting Period (ADR-0007). */
export async function finalizeVatReport(
  client: AppClient,
  input: { companyId: string; period: string },
): Promise<Result<null, FinalizeVatReportError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  if (!isReportingPeriod(input.period))
    return { ok: false, error: "invalid_reporting_period" };
  const { error } = await client.rpc("finalize_vat_report", {
    target_company_id: input.companyId,
    target_period: input.period,
  });
  if (error) return periodTransitionRefusal(error, ["report_not_found"]);
  return { ok: true, value: null };
}

/** Removes a Period Lock so the Company's Documents can be corrected again. */
export async function unlockReportingPeriod(
  client: AppClient,
  input: { companyId: string; period: string },
): Promise<Result<null, UnlockReportingPeriodError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  if (!isReportingPeriod(input.period))
    return { ok: false, error: "invalid_reporting_period" };
  const { error } = await client.rpc("unlock_reporting_period", {
    target_company_id: input.companyId,
    target_period: input.period,
  });
  if (error) return periodTransitionRefusal(error, ["not_locked"]);
  return { ok: true, value: null };
}

/** The active lock for a Reporting Period, visible to Company members. */
export async function getPeriodLock(
  client: AppClient,
  companyId: string,
  period: string,
): Promise<PeriodLock | null> {
  if (!isUuid(companyId) || !isReportingPeriod(period)) return null;
  const { data, error } = await client
    .from("period_lock")
    .select("company_id, period, vat_report_id, locked_by, locked_at")
    .eq("company_id", companyId)
    .eq("period", period)
    .maybeSingle();
  if (error) throw error;
  return data
    ? {
        companyId: data.company_id,
        period: data.period,
        vatReportId: data.vat_report_id,
        lockedBy: data.locked_by,
        lockedAt: data.locked_at,
      }
    : null;
}

/** Generates or replaces a draft for a valid monthly or quarterly Reporting Period. */
export async function generateVatReport(
  client: AppClient,
  input: { companyId: string; period: string },
): Promise<Result<{ id: string }, GenerateVatReportError>> {
  if (!isReportingPeriod(input.period))
    return { ok: false, error: "invalid_reporting_period" };
  const company = await getCompany(client, input.companyId);
  if (!company) return { ok: false, error: "forbidden" };
  const setup = await getCompanySetupChecklist(client, company.id);
  if (setup.some((item) => (item.step === "identity" || item.step === "filing_frequency") && item.state !== "completed")) {
    return { ok: false, error: "company_setup_incomplete" };
  }
  const frequency = await getFilingFrequencyForPeriod(
    client,
    company.id,
    input.period,
  );
  if (
    frequency === null ||
    (input.period.includes("-Q") ? frequency !== "quarterly" : frequency !== "monthly")
  ) {
    return { ok: false, error: "invalid_reporting_period" };
  }
  const readiness = await getReportingPeriodReadiness(client, input);
  if (!readiness.ok) return readiness;
  const filingFrequencies = await listCompanyFilingFrequencies(client, company.id);
  const { data, error } = await client.rpc("vat_report_documents", {
    target_company_id: company.id,
    target_period: input.period,
  });
  if (error) throw error;
  const documents = data as unknown as ReportDocument[];
  const details: CompanyDetails = {
    name: company.name,
    firstName: company.firstName,
    lastName: company.lastName,
    ico: company.ico,
    vatId: company.vatId,
    streetName: company.streetName,
    houseNumber: company.houseNumber,
    orientationNumber: company.orientationNumber,
    city: company.city,
    postalCode: company.postalCode,
    personType: company.personType,
  };
  const result = {
    ...computeVatReport(
      details,
      input.period,
      documents,
      filingFrequencies,
    ),
    readinessSource: readiness.value.source,
  };
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
    if (saved.error.code === "P0001" && saved.error.hint === "period_locked")
      return { ok: false, error: "period_locked" };
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
