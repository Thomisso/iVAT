import { expect, it } from "vitest";
import * as XLSX from "xlsx";
import { workbookRowsToText, workbookRows } from "@/application/workbooks";

it("keeps actual worksheet columns and absolute rows with header context for a Document", () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([]);
  XLSX.utils.sheet_add_aoa(sheet, [["Number", "VAT"], ["OTHER", "42.00"], ["CELL-240", "210.00"]], { origin: "D5" });
  sheet["!ref"] = "D5:E7";
  XLSX.utils.book_append_sheet(workbook, sheet, "Faktury říjen");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  expect(workbookRowsToText(bytes, { sheetName: "Faktury říjen", firstRow: 7, lastRow: 7 }))
    .toBe('[Sheet "Faktury říjen"]\n[Columns]\tD\tE\n5\tNumber\tVAT\n7\tCELL-240\t210.00');
});

it("exposes addressable cells and the actual header without leaking another Document's rows", () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([]);
  XLSX.utils.sheet_add_aoa(sheet, [["Number", "VAT"], ["OTHER", "42.00"], ["CELL-240", "210.00"]], { origin: "D5" });
  sheet["!ref"] = "D5:E7";
  XLSX.utils.book_append_sheet(workbook, sheet, "Faktury říjen");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["FOREIGN-SHEET"]]), "Other");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  expect(workbookRows(bytes, { sheetName: "Faktury říjen", firstRow: 7, lastRow: 7 })).toEqual({
    sheetName: "Faktury říjen", firstRow: 7, lastRow: 7, firstColumn: 4, lastColumn: 5, headerRow: 5,
    columns: [{ number: 4, label: "D" }, { number: 5, label: "E" }],
    rows: [
      { number: 5, context: true, cells: [{ address: "D5", column: 4, text: "Number" }, { address: "E5", column: 5, text: "VAT" }] },
      { number: 7, context: false, cells: [{ address: "D7", column: 4, text: "CELL-240" }, { address: "E7", column: 5, text: "210.00" }] },
    ],
  });
});
