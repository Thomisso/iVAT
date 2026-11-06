import { createTranslator } from "next-intl";
import messages from "../../messages/cs.json";
import type { PDFDocument, PDFFont } from "pdf-lib";
import type { VatReportExportHeader } from "./epo-export-context";
import { formatDate } from "@/lib/format-date";

// Czech form content is independent of the surrounding application locale.
export const pdfFormText = createTranslator({ locale: "cs", messages, namespace: "vatReports.pdfExport" });

/** Temporary readable header page shared by both exports until form artwork fills
 * the same resolved fields. Missing filing details remain visibly blank. */
export function appendPdfExportHeader(document: PDFDocument, font: PDFFont, header: VatReportExportHeader) {
  const page = document.addPage([595.28, 841.89]);
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
  lines.forEach((line, index) => page.drawText(line, { x: 42, y: 790 - index * 28, size: index === 0 ? 16 : 10, font }));
}


export function pdfExportCompany(header: VatReportExportHeader) {
  return { ...header.company, ...(header.details.address ?? {
    streetName: "", houseNumber: "", orientationNumber: null, city: "", postalCode: "",
  }) };
}
