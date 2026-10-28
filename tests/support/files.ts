import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";

/** The bytes of a file in `tests/fixtures/`. */
export function fixtureFile(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "fixtures", name)));
}

/** A genuine in-memory Excel workbook for application tests. */
export function workbookFile(
  bookType: "xlsx" | "xls",
  rows: unknown[][],
  sheetName = "Invoices",
): Uint8Array {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), sheetName);
  return new Uint8Array(XLSX.write(workbook, { bookType, type: "buffer", cellDates: true }));
}
