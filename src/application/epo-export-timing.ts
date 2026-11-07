import type { PersonType } from "./companies";
import { isExportCalendarDate, type EpoFormat } from "./epo-export-details";
import { reportingPeriodStart } from "./reporting-periods";

export type ExportTimingWarning = "prepared_on_future" | "reporting_period_unfinished" | "potentially_late_filing" | "control_statement_monthly_required";
export type ExportTiming = {
  today: string;
  periodEndsOn: string | null;
  filingKind: "ordinary";
  deadline: string | null;
  warnings: ExportTimingWarning[];
};

// Czech non-working days under 245/2000 Sb. §§1–3, not commemorative days.
function isNonWorkingDay(date: Date): boolean {
  if (date.getUTCDay() === 0 || date.getUTCDay() === 6) return true;
  if (["01-01", "05-01", "05-08", "07-05", "07-06", "09-28", "10-28", "11-17", "12-24", "12-25", "12-26"].includes(date.toISOString().slice(5, 10))) return true;
  const year = date.getUTCFullYear();
  const easter = easterSunday(year);
  const offset = (date.getTime() - easter.getTime()) / 86_400_000;
  return offset === 1 || (year >= 2016 && offset === -2);
}

/** Gregorian Easter (Meeus/Jones/Butcher), calculated in UTC calendar days. */
function easterSunday(year: number): Date {
  const golden = year % 19;
  const century = Math.floor(year / 100);
  const withinCentury = year % 100;
  const leapCenturies = Math.floor(century / 4);
  const centuryRemainder = century % 4;
  const correction = Math.floor((century - Math.floor((century + 8) / 25) + 1) / 3);
  const epact = (19 * golden + century - leapCenturies - correction + 15) % 30;
  const weekday = (32 + 2 * centuryRemainder + 2 * Math.floor(withinCentury / 4) - epact - withinCentury % 4) % 7;
  const adjustment = Math.floor((golden + 11 * epact + 22 * weekday) / 451);
  const easter = epact + weekday - 7 * adjustment + 114;
  return new Date(Date.UTC(year, Math.floor(easter / 31) - 1, easter % 31 + 1));
}

/** Advisory calendar evaluation for the ordinary B outputs emitted by our serializer. */
export function exportTiming(input: {
  period: string;
  format: EpoFormat;
  personType: PersonType;
  preparedOn: string;
  today: string;
}): ExportTiming {
  const start = reportingPeriodStart(input.period);
  const end = start ? new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1 + (input.period.includes("-Q") ? 3 : 1), 0)) : null;
  const periodEndsOn = end?.toISOString().slice(0, 10) ?? null;
  // Legal persons file KH monthly even when their VAT Return is quarterly.
  const monthlyControlRequired = input.format === "dphkh1" && input.personType === "legal" && input.period.includes("-Q");
  const due = end && !monthlyControlRequired ? new Date(end) : null;
  if (due) due.setUTCDate(due.getUTCDate() + 25);
  const deadline = due ? nextCzechWorkingDate(due.toISOString().slice(0, 10)) : null;
  const preparedOn = isExportCalendarDate(input.preparedOn) ? input.preparedOn : null;
  const warnings: ExportTimingWarning[] = [];
  if (preparedOn && preparedOn > input.today) warnings.push("prepared_on_future");
  if (periodEndsOn && input.today <= periodEndsOn) warnings.push("reporting_period_unfinished");
  if (deadline && (input.today > deadline || (preparedOn && preparedOn > deadline))) warnings.push("potentially_late_filing");
  if (monthlyControlRequired) warnings.push("control_statement_monthly_required");
  return { today: input.today, periodEndsOn, filingKind: "ordinary", deadline, warnings };
}

/** A Czech civil deadline, using the holiday law applicable on that day. */
export function nextCzechWorkingDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  while (isNonWorkingDay(date)) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
