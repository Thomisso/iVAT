import { isUuid, type AppClient, type Result } from "./client";
import { FILING_FREQUENCIES, listCompanyReportingYears, type FilingFrequency } from "./companies";
import type { ValidationFinding } from "./document-validation";
import { reportingPeriodGapFinding } from "./reporting-periods";

// Administrator commands on a Company's Reporting Years (ADR-0013). The
// database decides who may run them and refuses changes to years in use.

export type GenerateReportingYearsError =
  | "invalid_reporting_year"
  | "too_many_reporting_years"
  | "invalid_filing_frequency"
  | "forbidden";

/** The most years one generation request may create. */
export const MAX_GENERATED_REPORTING_YEARS = 20;

const validYear = (year: number) => Number.isInteger(year) && year >= 2000 && year <= 2099;
const validFrequency = (frequency: string): frequency is FilingFrequency =>
  FILING_FREQUENCIES.some((known) => known === frequency);

/**
 * Generates every missing year from `fromYear` through `toYear`; existing years
 * are skipped, never overwritten.
 */
export async function generateReportingYears(
  client: AppClient,
  input: { companyId: string; fromYear: number; toYear: number; frequency: FilingFrequency },
): Promise<Result<{ generated: number[]; skipped: number[] }, GenerateReportingYearsError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  if (!validFrequency(input.frequency)) return { ok: false, error: "invalid_filing_frequency" };
  if (!validYear(input.fromYear) || !validYear(input.toYear) || input.fromYear > input.toYear) {
    return { ok: false, error: "invalid_reporting_year" };
  }
  if (input.toYear - input.fromYear >= MAX_GENERATED_REPORTING_YEARS) {
    return { ok: false, error: "too_many_reporting_years" };
  }
  const { data, error } = await client.rpc("generate_company_reporting_years", {
    target_company_id: input.companyId,
    from_year: input.fromYear,
    to_year: input.toYear,
    new_frequency: input.frequency,
  });
  if (error) {
    return changeRefusal(error, [
      "invalid_reporting_year",
      "too_many_reporting_years",
    ] as const);
  }
  const result = data as { generated: number[]; skipped: number[] };
  return { ok: true, value: { generated: result.generated, skipped: result.skipped } };
}

export type ChangeReportingYearError =
  | "reporting_year_not_found"
  | "reporting_year_in_use"
  | "invalid_filing_frequency"
  | "forbidden";

type RpcError = { code: string; hint: string | null } | null;

function changeRefusal<E extends string>(error: NonNullable<RpcError>, hints: readonly E[]): Result<never, E | "forbidden"> {
  if (error.code === "42501") return { ok: false, error: "forbidden" };
  const hint = hints.find((known) => known === error.hint);
  if (error.code === "P0001" && hint) return { ok: false, error: hint };
  throw error;
}

/** Changes the frequency of a generated year none of whose periods has a VAT Report or Period Lock. */
export async function changeReportingYearFrequency(
  client: AppClient,
  input: { companyId: string; year: number; frequency: FilingFrequency },
): Promise<Result<null, ChangeReportingYearError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  if (!validFrequency(input.frequency)) return { ok: false, error: "invalid_filing_frequency" };
  if (!validYear(input.year)) return { ok: false, error: "reporting_year_not_found" };
  const { error } = await client.rpc("change_company_reporting_year_frequency", {
    target_company_id: input.companyId,
    target_year: input.year,
    new_frequency: input.frequency,
  });
  if (error) {
    return changeRefusal(error, ["reporting_year_not_found", "reporting_year_in_use", "invalid_filing_frequency"] as const);
  }
  return { ok: true, value: null };
}

/** Deletes a generated year none of whose periods has a VAT Report or Period Lock; its Documents lose their period. */
export async function deleteReportingYear(
  client: AppClient,
  input: { companyId: string; year: number },
): Promise<Result<null, Exclude<ChangeReportingYearError, "invalid_filing_frequency">>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  if (!validYear(input.year)) return { ok: false, error: "reporting_year_not_found" };
  const { error } = await client.rpc("delete_company_reporting_year", {
    target_company_id: input.companyId,
    target_year: input.year,
  });
  if (error) return changeRefusal(error, ["reporting_year_not_found", "reporting_year_in_use"] as const);
  return { ok: true, value: null };
}

export type SetFirstReportingMonthError =
  | Exclude<ChangeReportingYearError, "invalid_filing_frequency">
  | "not_first_reporting_year"
  | "invalid_first_month";

/**
 * Starts the earliest Reporting Year in `firstMonth`, for a Company that became
 * a VAT payer mid-year. A quarterly year starts on a quarter (1, 4, 7 or 10).
 */
export async function setFirstReportingMonth(
  client: AppClient,
  input: { companyId: string; year: number; firstMonth: number },
): Promise<Result<null, SetFirstReportingMonthError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  if (!validYear(input.year)) return { ok: false, error: "reporting_year_not_found" };
  if (!Number.isInteger(input.firstMonth) || input.firstMonth < 1 || input.firstMonth > 12) {
    return { ok: false, error: "invalid_first_month" };
  }
  const { error } = await client.rpc("set_company_first_reporting_month", {
    target_company_id: input.companyId,
    target_year: input.year,
    new_first_month: input.firstMonth,
  });
  if (error) {
    return changeRefusal(error, [
      "reporting_year_not_found",
      "reporting_year_in_use",
      "not_first_reporting_year",
      "invalid_first_month",
    ] as const);
  }
  return { ok: true, value: null };
}

/**
 * Why a Document has no Reporting Period, as a blocking finding (see
 * `reportingPeriodGapFinding`). Computed when read, so it disappears as soon as
 * the missing year exists.
 */
export async function missingReportingPeriodFinding(
  client: AppClient,
  companyId: string,
  documentId: string,
): Promise<ValidationFinding | null> {
  if (!isUuid(companyId) || !isUuid(documentId)) return null;
  const [{ data: document, error }, years] = await Promise.all([
    client
      .from("document_overview")
      .select("tax_point_date, reporting_period")
      .eq("company_id", companyId)
      .eq("id", documentId)
      .maybeSingle(),
    listCompanyReportingYears(client, companyId),
  ]);
  if (error) throw error;
  if (!document || document.reporting_period) return null;
  return reportingPeriodGapFinding(document.tax_point_date, years);
}
