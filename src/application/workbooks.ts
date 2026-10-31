import * as XLSX from "xlsx";

export type WorkbookRowSet = {
  sheetName: string;
  firstRow: number;
  lastRow: number;
};

/** Both AI and manual Split must refer to actual, disjoint worksheet rows. */
export function assertWorkbookRanges(sheets: WorkbookRowSet[], ranges: unknown): asserts ranges is WorkbookRowSet[] {
  if (!Array.isArray(ranges) || ranges.length === 0) throw new Error("Workbook row sets are required");
  const previousLastRow = new Map<string, number>();
  for (const range of ranges) {
    if (!range || typeof range !== "object" || Array.isArray(range)
      || Object.keys(range).some((key) => !["sheetName", "firstRow", "lastRow"].includes(key))) {
      throw new Error("A workbook Split must return row sets");
    }
    const sheet = sheets.find(({ sheetName }) => sheetName === range.sheetName);
    if (!sheet || !Number.isSafeInteger(range.firstRow) || !Number.isSafeInteger(range.lastRow)
      || range.firstRow < sheet.firstRow || range.lastRow < range.firstRow || range.lastRow > sheet.lastRow
      || range.firstRow <= (previousLastRow.get(range.sheetName) ?? 0)) {
      throw new Error("Workbook row sets must be ascending, disjoint, and within their worksheets");
    }
    previousLastRow.set(range.sheetName, range.lastRow);
  }
}

type ParsedSheet = WorkbookRowSet & { worksheet: XLSX.WorkSheet };

function parsedSheets(bytes: Uint8Array): ParsedSheet[] {
  const workbook = XLSX.read(bytes.slice(), {
    type: "array",
    cellDates: true,
    cellFormula: false,
    cellHTML: false,
    cellNF: false,
    bookVBA: false,
  });
  return workbook.SheetNames.flatMap((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet?.["!ref"]) return [];
    const range = XLSX.utils.decode_range(worksheet["!ref"]);
    return [{ sheetName, firstRow: range.s.r + 1, lastRow: range.e.r + 1, worksheet }];
  });
}

function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.v === null || cell.v === undefined) return "";
  const value = cell.v;
  const text = value instanceof Date
    ? value.toISOString().slice(0, 10)
    : typeof value === "boolean"
      ? value ? "TRUE" : "FALSE"
      : String(value);
  return text.replace(/[\t\r\n]+/g, " ").trim();
}

function rowText(sheet: ParsedSheet, row: number): string {
  const range = XLSX.utils.decode_range(sheet.worksheet["!ref"]!);
  const values = Array.from(
    { length: range.e.c - range.s.c + 1 },
    (_, offset) => cellText(sheet.worksheet[XLSX.utils.encode_cell({ r: row - 1, c: range.s.c + offset })]),
  );
  while (values.at(-1) === "") values.pop();
  return `${row}\t${values.join("\t")}`;
}

function tableText(sheet: ParsedSheet, rows: number[]): string {
  return [`[Sheet "${sheet.sheetName.replaceAll('"', '""')}"]`, ...rows.map((row) => rowText(sheet, row))].join("\n");
}

/** Converts every populated worksheet to deterministic, row-numbered plain text. */
export function workbookToText(bytes: Uint8Array): { text: string; rowSets: WorkbookRowSet[] } {
  const sheets = parsedSheets(bytes);
  if (sheets.length === 0) throw new Error("Workbook has no populated worksheets");
  return {
    text: sheets
      .map((sheet) => tableText(
        sheet,
        Array.from({ length: sheet.lastRow - sheet.firstRow + 1 }, (_, offset) => sheet.firstRow + offset),
      ))
      .join("\n\n"),
    rowSets: sheets.map(({ sheetName, firstRow, lastRow }) => ({ sheetName, firstRow, lastRow })),
  };
}

/** The source rows for one row-based Document, including the sheet's header row as context. */
export function workbookRowsToText(bytes: Uint8Array, rowSet: WorkbookRowSet): string {
  const sheet = parsedSheets(bytes).find(({ sheetName }) => sheetName === rowSet.sheetName);
  if (!sheet || rowSet.firstRow < sheet.firstRow || rowSet.lastRow > sheet.lastRow || rowSet.lastRow < rowSet.firstRow) {
    throw new Error("Document row set is outside the workbook");
  }
  const rows = Array.from({ length: rowSet.lastRow - rowSet.firstRow + 1 }, (_, offset) => rowSet.firstRow + offset);
  if (sheet.firstRow < rowSet.firstRow) rows.unshift(sheet.firstRow);
  return tableText(sheet, rows);
}
