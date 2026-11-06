import { createTranslator } from "next-intl";
import messages from "../../messages/cs.json";
import type { PDFDocument, PDFFont } from "pdf-lib";
import type { VatReportExportHeader } from "./epo-export-context";
import { formatDate } from "@/lib/format-date";

// Czech form content is independent of the surrounding application locale.
export const pdfFormText = createTranslator({ locale: "cs", messages, namespace: "vatReports.pdfExport" });

/** Break text at spaces where possible, and split unbroken values such as email
 * addresses by measured glyph width. No portion may extend beyond the margin. */
function wrapHeaderField(value: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let remaining = Array.from(value);
  while (font.widthOfTextAtSize(remaining.join(""), size) > width) {
    let end = 1;
    while (end < remaining.length && font.widthOfTextAtSize(remaining.slice(0, end + 1).join(""), size) <= width) end++;
    const lastSpace = remaining.slice(0, end + 1).lastIndexOf(" ");
    const split = lastSpace > 0 ? lastSpace : end;
    lines.push(remaining.slice(0, split).join(""));
    remaining = remaining.slice(split);
    while (remaining[0] === " ") remaining.shift();
  }
  lines.push(remaining.join(""));
  return lines;
}

/** Temporary readable header page shared by both exports until form artwork fills
 * the same resolved fields. Missing filing details remain visibly blank. */
export function appendPdfExportHeader(document: PDFDocument, font: PDFFont, header: VatReportExportHeader) {
  let page = document.addPage([595.28, 841.89]);
  const details = header.details;
  const address = details.address;
  const t = pdfFormText;
  const lines = [
    t("heading"), header.company.name,
    t("vatId", { value: header.company.vatId }), t("ico", { value: header.company.ico }),
    t("period", { value: header.period }),
    t("taxOffice", { value: details.taxOffice }),
    t("territorialOffice", { value: details.territorialOffice }),
    t("economicActivity", { value: details.economicActivity }),
    t("preparedOn", { value: details.preparedOn ? formatDate(details.preparedOn) : "" }),
    t("email", { value: details.email }), t("phone", { value: details.phone }),
    ...(details.personType === "P" ? [
      t("signatory", { value: `${details.signatoryFirstName} ${details.signatoryLastName}`.trim() }),
      t("capacity", { value: details.signatoryCapacity }),
    ] : []),
    t("address", { value: address ? `${address.streetName} ${address.houseNumber}${address.orientationNumber ? `/${address.orientationNumber}` : ""}` : "" }),
    address ? `${address.postalCode} ${address.city}` : "",
  ];
  let y = 790;
  lines.forEach((line, index) => {
    const size = index === 0 ? 16 : 10;
    const lineHeight = index === 0 ? 22 : 14;
    for (const wrapped of wrapHeaderField(line, font, size, page.getWidth() - 84)) {
      if (y - size < 42) {
        page = document.addPage([595.28, 841.89]);
        y = 790;
      }
      page.drawText(wrapped, { x: 42, y, size, font });
      y -= lineHeight;
    }
    y -= index === 0 ? 6 : 14;
  });
}


export function pdfExportCompany(header: VatReportExportHeader) {
  return { ...header.company, ...(header.details.address ?? {
    streetName: "", houseNumber: "", orientationNumber: null, city: "", postalCode: "",
  }) };
}
