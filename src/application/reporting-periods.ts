import type { ReportingYear } from "./companies";

export const isReportingPeriod = (value: string): boolean =>
  /^(20\d{2})-(0[1-9]|1[0-2]|Q[1-4])$/.test(value);

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
