const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const PRAGUE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Prague",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function pragueParts(value: string) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new Error(`Not a date: ${value}`);
  const parts = Object.fromEntries(
    PRAGUE.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.day}.${parts.month}.${parts.year}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/**
 * Shows a date as dd.mm.rrrr in either UI language, independent of the
 * browser locale. A calendar date (yyyy-mm-dd) is shown as is; a timestamp
 * is shown as its calendar day in Prague.
 */
export function formatDate(value: string): string {
  const calendar = CALENDAR_DATE.exec(value);
  if (calendar) return `${calendar[3]}.${calendar[2]}.${calendar[1]}`;
  return pragueParts(value).date;
}

/** Shows a timestamp as dd.mm.rrrr hh:mm in Prague time. */
export function formatDateTime(value: string): string {
  const { date, time } = pragueParts(value);
  return `${date} ${time}`;
}

const TYPED_DATE = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/;

/**
 * Reads what a User typed into a date input (dd.mm.rrrr) as a calendar date
 * (yyyy-mm-dd). Empty text means no date.
 */
export function parseDateInput(
  text: string,
): { ok: true; value: string } | { ok: false; error: "invalid_date" } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: "" };
  const match = TYPED_DATE.exec(trimmed);
  if (!match) return { ok: false, error: "invalid_date" };
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false, error: "invalid_date" };
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return { ok: true, value: `${year}-${pad(month)}-${pad(day)}` };
}
