import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type PDFDocument, type PDFFont, type PDFPage } from "pdf-lib";
import messages from "../../messages/cs.json";
import { ECONOMIC_ACTIVITIES, TERRITORIAL_OFFICES } from "./epo-catalogues";
import { isExportCalendarDate } from "./epo-export-details";
import type { VatReportExportHeader } from "./epo-export-context";

export type FormCell = readonly [number, number, number, number];
export function loadFormAsset(name: string) {
  return readFile(path.join(process.cwd(), "assets/pdf", name));
}
export async function embedFormFont(document: PDFDocument) {
  document.registerFontkit(fontkit);
  return document.embedFont(await loadFormAsset("fonts/LiberationSans-Regular.ttf"), { subset: true });
}

function wrap(value: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  let line = "";
  for (const character of value.replace(/[\r\n\t]/g, " ")) {
    if (line && font.widthOfTextAtSize(line + character, size) > width) {
      lines.push(line);
      line = "";
    }
    line += character;
  }
  if (line) lines.push(line);
  return lines;
}

/** Coordinates use the displayed page's top-left origin. Keep all glyphs inside
 * the cell, wrapping unusually long valid contact data before reducing size. */
export function drawFormCell(page: PDFPage, font: PDFFont, value: string | undefined | null, cell: FormCell, options: { align?: "left" | "right" | "center"; size?: number } = {}) {
  if (!value) return;
  const [left, top, right, bottom] = cell;
  const width = right - left - 6;
  const height = bottom - top - 3;
  let size = options.size ?? 10;
  let lines = wrap(value, font, size, width);
  while (lines.length * size * 1.05 > height && size > .5) {
    size -= .25;
    lines = wrap(value, font, size, width);
  }
  const blockHeight = lines.length * size * 1.05;
  lines.forEach((line, index) => {
    const textWidth = font.widthOfTextAtSize(line, size);
    const x = options.align === "right" ? right - 3 - textWidth : options.align === "center" ? left + (right - left - textWidth) / 2 : left + 3;
    page.drawText(line, { x, y: page.getHeight() - top - (bottom - top - blockHeight) / 2 - size * .82 - index * size * 1.05, size, font });
  });
}

/** The same Czech header map fills the first page of complete exports and the
 * independent one-page preview. No report amounts are needed here. */
export function drawFormHeader(page: PDFPage, font: PDFFont, header: VatReportExportHeader, form: "vat-return" | "control-statement") {
  const vat = form === "vat-return";
  const details = header.details;
  const company = header.company;
  const cell = (value: string | undefined | null, coordinates: FormCell, options?: Parameters<typeof drawFormCell>[4]) => drawFormCell(page, font, value, coordinates, options);
  const taxNames: Record<string, string> = messages.epoExport.taxOffices;
  cell(taxNames[details.taxOffice]?.replace(/^FÚ pro /, ""), [42.8, 51.3, 269, 67.8]);
  cell(TERRITORIAL_OFFICES.find(office => office.code === details.territorialOffice && office.taxOffice === details.taxOffice)?.name.replace(/^Územní pracoviště (?:v |ve |pro )?/, ""), [42.8, 79.6, 269, 96.1]);
  cell(company.vatId.replace(/^CZ/, ""), [71, 108, 213.3, 124.5]);
  cell("X", [85, vat ? 156.7 : 128.6, 107.5, vat ? 173.2 : 145.1], { align: "center", size: 12 });
  const periodTop = vat ? 261.1 : 289;
  const [year, period] = header.period.split("-");
  cell(period.startsWith("Q") ? "" : String(Number(period)), [253.6, periodTop, 309.8, periodTop + 16.5], { align: "center" });
  cell(period.startsWith("Q") ? period.slice(1) : "", [361.1, periodTop, 417.3, periodTop + 16.5], { align: "center" });
  cell(year, [447, periodTop, 503.2, periodTop + 16.5], { align: "center" });
  if (vat) {
    cell(company.ico, [42.8, 136.4, 184.5, 152.9]);
    cell("X", [136.3, 300.8, 164.6, 317.6], { align: "center", size: 12 });
  }
  if (details.personType === "P") {
    let nameSize = 10;
    let nameLines = wrap(company.name, font, nameSize, 517.9);
    // The second printed line is shorter; fit the remainder there at the same
    // size instead of making a long legal name tiny in the first field.
    while (font.widthOfTextAtSize(nameLines.slice(1).join(""), nameSize) > 347.9 && nameSize > 1) {
      nameSize -= .25;
      nameLines = wrap(company.name, font, nameSize, 517.9);
    }
    cell(nameLines[0], [42.8, 349, 566.7, 365.5], { size: nameSize });
    cell(nameLines.slice(1).join(""), [42.7, 368.9, 396.6, 385.4], { size: nameSize });
    cell([details.signatoryFirstName, details.signatoryLastName, details.signatoryCapacity].filter(Boolean).join(" "), [49.9, vat ? 683.1 : 705.4, 559.6, vat ? 699.6 : 721.9]);
  } else {
    cell(company.lastName, [42.7, 400, 339.9, 416.5]);
    cell(company.firstName, [354.3, 400, 495.2, 416.5]);
  }
  const representative = details.representative;
  if (representative) {
    cell(representative.code, [191.6, vat ? 576.1 : 598.4, 219.4, vat ? 592.6 : 614.9]);
    cell([representative.firstName, representative.lastName].filter(Boolean).join(" "), [49.9, vat ? 605.8 : 628.1, 559.6, vat ? 622.3 : 644.6]);
    const date = representative.birthDate ? representative.birthDate.split("-").reverse().join(".") : "";
    cell([date, representative.evidenceNumber].filter(Boolean).join(" / "), [49.9, vat ? 634.2 : 656.5, 559.6, vat ? 650.7 : 673]);
  }
  const address = details.address;
  cell(address?.city, [42.8, 439.6, vat ? 298.8 : 482.9, 456.2]);
  cell(address?.postalCode, [vat ? 312 : 496, 439.6, vat ? 383 : 567, 456.1]);
  cell(address?.streetName, [42.8, 468, 424.9, 484.5]);
  cell(address ? `${address.houseNumber}${address.orientationNumber ? `/${address.orientationNumber}` : ""}` : "", [439.6, 468, 566.7, 484.5]);
  cell(details.phone, [396.4, vat ? 439.3 : 496.2, 566.9, vat ? 455.8 : 512.7]);
  cell(details.email, [vat ? 42.4 : 168.4, vat ? 496.4 : 524.1, 566.2 - (vat ? 240.3 : 0), vat ? 512.9 : 540.6]);
  cell("ČESKÁ REPUBLIKA", [vat ? 340.1 : 43.8, vat ? 496.4 : 496, vat ? 566.9 : 382.6, vat ? 512.9 : 512.5]);
  if (vat) cell(ECONOMIC_ACTIVITIES.find(activity => activity.code === details.economicActivity)?.name ? `${details.economicActivity} ${ECONOMIC_ACTIVITIES.find(activity => activity.code === details.economicActivity)!.name}` : "", [42.8, 524.8, 566.7, 541.3]);
  if (isExportCalendarDate(details.preparedOn)) {
    const [year, month, day] = details.preparedOn.split("-");
    Array.from(`${day}${month}${year}`).forEach((digit, index) => cell(digit, [49.9 + 14.2 * index, vat ? 727 : 749.3, 64.1 + 14.2 * index, vat ? 743.5 : 765.8], { align: "center", size: 11 }));
  }
  cell(details.phone, [439.7, vat ? 770.3 : 792.6, 566.7, vat ? 786.8 : 809.1]);
}
