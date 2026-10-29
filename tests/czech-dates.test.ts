import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, parseDateInput } from "@/lib/format-date";

describe("Czech date format", () => {
  it("shows a calendar date as dd.mm.rrrr", () => {
    expect(formatDate("2026-03-05")).toBe("05.03.2026");
  });

  it("shows a timestamp as the calendar day in Prague", () => {
    expect(formatDate("2026-03-31T22:30:00.000Z")).toBe("01.04.2026");
  });

  it("shows a timestamp with its Prague time as dd.mm.rrrr hh:mm", () => {
    expect(formatDateTime("2026-01-15T08:05:00+00:00")).toBe("15.01.2026 09:05");
    expect(formatDateTime("2026-07-01T21:59:00Z")).toBe("01.07.2026 23:59");
  });

  it("reads typed dd.mm.rrrr text as a calendar date", () => {
    expect(parseDateInput("05.03.2026")).toEqual({ ok: true, value: "2026-03-05" });
    expect(parseDateInput(" 5. 3. 2026 ")).toEqual({ ok: true, value: "2026-03-05" });
  });

  it("reads an empty input as no date", () => {
    expect(parseDateInput("  ")).toEqual({ ok: true, value: "" });
  });

  it("rejects text that is not a real dd.mm.rrrr date", () => {
    for (const text of ["2026-03-05", "31.04.2026", "29.02.2027", "00.01.2026", "1.13.2026", "05.03.26", "abc"]) {
      expect(parseDateInput(text)).toEqual({ ok: false, error: "invalid_date" });
    }
    expect(parseDateInput("29.02.2028")).toEqual({ ok: true, value: "2028-02-29" });
  });
});
