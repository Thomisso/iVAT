import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";

/** The bytes of a file in `tests/fixtures/`. */
export function fixtureFile(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "fixtures", name)));
}

/** A genuine, compact HEIC image fixture (16 × 16 pixels). */
export function heicFixture(): Uint8Array {
  return new Uint8Array(Buffer.from(
    "AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAACCG1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAABhaWluZgAAAAAAAwAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAAClpbmZlAgAAAQADAABtaW1lAGFwcGxpY2F0aW9uL3JkZit4bWwAAAAAKGlyZWYAAAAAAAAADmNkc2MAAgABAAEAAAAOY2RzYwADAAEAAQAAAOZpcHJwAAAAxWlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAAAEAAAABAAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAAcWh2Y0MBA3AAAACwAAAAAAAe8AD8/fj4AAALA6AAAQAXQAEMAf//A3AAAAMAsAAAAwAAAwAecCShAAEAI0IBAQNwAAADALAAAAMAAAMAHqAUIEHAkwziHuRZVNwICBgCogABAAlEAcBhcshAUyQAAAAZaXBtYQAAAAAAAAABAAEGgQIDBYaEAAAAOmlsb2MAAAAARAAAAwABAAAAAQAABRQAAABLAAIAAAABAAACPAAAAPoAAwAAAAEAAAM2AAAB3gAAAAFtZGF0AAAAAAAAAzMAAAAGRXhpZgAATU0AKgAAAAgABwESAAMAAAABAAEAAAEaAAUAAAABAAAAYgEbAAUAAAABAAAAagEoAAMAAAABAAIAAAExAAIAAAAfAAAAcgEyAAIAAAAUAAAAkodpAAQAAAABAAAApgAAAAAAAABIAAAAAQAAAEgAAAABQWRvYmUgUGhvdG9zaG9wIDI3LjMgKFdpbmRvd3MpAAAyMDI2OjA2OjA3IDEyOjExOjQ4AAAEkAQAAgAAABQAAADcoAEAAwAAAAEAAQAAoAIABAAAAAEAAAAZoAMABAAAAAEAAAAaAAAAADIwMjY6MDY6MDcgMTE6MDI6MTkAPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iWE1QIENvcmUgNi4wLjAiPgogICA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPgogICAgICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgICAgICAgICB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iPgogICAgICAgICA8eG1wOk1vZGlmeURhdGU+MjAyNi0wNi0wN1QxMjoxMTo0ODwveG1wOk1vZGlmeURhdGU+CiAgICAgICAgIDx4bXA6Q3JlYXRvclRvb2w+QWRvYmUgUGhvdG9zaG9wIDI3LjMgKFdpbmRvd3MpPC94bXA6Q3JlYXRvclRvb2w+CiAgICAgICAgIDx4bXA6Q3JlYXRlRGF0ZT4yMDI2LTA2LTA3VDExOjAyOjE5KzAyOjAwPC94bXA6Q3JlYXRlRGF0ZT4KICAgICAgPC9yZGY6RGVzY3JpcHRpb24+CiAgIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+CgAAAEcoAa+jaytnuJuJqX+lu/ycuL1FE1Fa0mSaYlmjqzCHBDArHqZrgTaYXetyPAfj5ipoOL3/4CDShJgtQEOCwP/8XhYgmBAjHA==",
    "base64",
  ));
}

/** The HEIC fixture with its lossless display rotation metadata set to 90° counter-clockwise. */
export function rotatedHeicFixture(): Uint8Array {
  const bytes = heicFixture();
  const rotationProperty = Buffer.from(bytes).indexOf(Buffer.from("irot"));
  if (rotationProperty === -1) throw new Error("HEIC fixture has no rotation property");
  bytes[rotationProperty + 4] = 1;
  return bytes;
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
