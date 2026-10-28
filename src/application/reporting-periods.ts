import type { FilingFrequency, FilingFrequencyHistoryEntry } from "./companies";

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

export function filingFrequencyAt(
  date: string,
  history: readonly FilingFrequencyHistoryEntry[],
): FilingFrequency | null {
  return history
    .filter((entry) => entry.effectiveFrom <= date)
    .toSorted((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]
    ?.frequency ?? null;
}

export function reportingPeriodForDate(
  date: string,
  history: readonly FilingFrequencyHistoryEntry[],
): string | null {
  const frequency = filingFrequencyAt(date, history);
  if (!frequency) return null;
  if (frequency === "monthly") return date.slice(0, 7);
  return `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
}

/** Every valid Reporting Period from the first filing-frequency entry through a date, oldest first. */
export function reportingPeriodsThrough(
  throughDate: string,
  history: readonly FilingFrequencyHistoryEntry[],
): string[] {
  const first = history.toSorted((a, b) =>
    a.effectiveFrom.localeCompare(b.effectiveFrom),
  )[0]?.effectiveFrom;
  if (!first || !/^20\d{2}-\d{2}-\d{2}$/.test(throughDate)) return [];
  const cursor = new Date(`${first.slice(0, 7)}-01T00:00:00Z`);
  const through = `${throughDate.slice(0, 7)}-01`;
  const periods = new Set<string>();
  while (cursor.toISOString().slice(0, 10) <= through) {
    const date = cursor.toISOString().slice(0, 10);
    const period = reportingPeriodForDate(date, history);
    if (period) periods.add(period);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return [...periods];
}

export function validFilingEffectiveFrom(
  frequency: FilingFrequency,
  value: string,
): boolean {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) return false;
  const [, month, day] = value.split("-");
  return day === "01" && (frequency !== "quarterly" || ["01", "04", "07", "10"].includes(month));
}
