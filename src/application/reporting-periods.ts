import type { ReportingYear } from "./companies";
import type { ValidationFinding } from "./document-validation";

/** The list filter for Documents without a Reporting Period, such as those outside every generated Reporting Year. */
export const NO_REPORTING_PERIOD = "none";

export const isReportingPeriod = (value: string): boolean =>
  /^(20\d{2})-(0[1-9]|1[0-2]|Q[1-4])$/.test(value);

/** A list filter from a URL value: a Reporting Period, NO_REPORTING_PERIOD, or undefined for anything else. */
export function parseReportingPeriodFilter(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const filter = value.trim();
  return filter === NO_REPORTING_PERIOD || isReportingPeriod(filter) ? filter : undefined;
}

export function reportingPeriodStart(period: string): string | null {
  const month = /^(20\d{2})-(0[1-9]|1[0-2])$/.exec(period);
  if (month) return `${period}-01`;
  const quarter = /^(20\d{2})-Q([1-4])$/.exec(period);
  if (!quarter) return null;
  const firstMonth = (Number(quarter[2]) - 1) * 3 + 1;
  return `${quarter[1]}-${String(firstMonth).padStart(2, "0")}-01`;
}

/** The Reporting Period of a date: the month or quarter of its Reporting Year, or null outside every generated year. */
export function reportingPeriodForDate(
  date: string,
  years: readonly ReportingYear[],
): string | null {
  const year = years.find((entry) => entry.year === Number(date.slice(0, 4)));
  const month = Number(date.slice(5, 7));
  if (!year || month < year.firstMonth) return null;
  if (year.frequency === "monthly") return date.slice(0, 7);
  return `${date.slice(0, 4)}-Q${Math.ceil(month / 3)}`;
}

/**
 * Why a Tax Point Date has no Reporting Period, as a blocking finding: its year
 * was never generated, or it precedes the month its year starts. Null when the
 * date has a period or is not a valid date.
 */
export function reportingPeriodGapFinding(
  taxPointDate: string | null | undefined,
  years: readonly ReportingYear[],
): ValidationFinding | null {
  if (!taxPointDate || !/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(taxPointDate)) return null;
  if (reportingPeriodForDate(taxPointDate, years)) return null;
  const year = taxPointDate.slice(0, 4);
  const reportingYear = years.find((entry) => entry.year === Number(year));
  if (!reportingYear) {
    return { field: "taxPointDate", severity: "error", code: "reporting_year_missing", params: { year } };
  }
  return {
    field: "taxPointDate",
    severity: "error",
    code: "tax_point_date_before_first_reporting_month",
    params: { year, month: String(reportingYear.firstMonth) },
  };
}

/** Every Reporting Period of the generated years, oldest first. */
export function reportingPeriodsOf(years: readonly ReportingYear[]): string[] {
  const periods = new Set<string>();
  for (const year of years.toSorted((a, b) => a.year - b.year)) {
    for (let month = year.firstMonth; month <= 12; month += 1) {
      const period = reportingPeriodForDate(
        `${year.year}-${String(month).padStart(2, "0")}-01`,
        [year],
      );
      if (period) periods.add(period);
    }
  }
  return [...periods];
}

/** The calendar year in Prague, which onboarding generates. */
export function currentReportingYear(now = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague", year: "numeric" }).format(now));
}

/** The Prague calendar date (YYYY-MM-DD) of a timestamp. */
export function pragueDate(timestamp: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date(timestamp));
}
