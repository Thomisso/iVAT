import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { AppClient, Result } from "./client";
import { registeredAddressLine } from "./companies";
import {
  controlStatementPreviewData,
  type ControlStatementPreviewData,
} from "./control-statement-preview";
import { appendPdfExportHeader, pdfExportCompany, pdfFormText } from "./pdf-export-header";
import { resolveEpoExportDetails, todayInPrague, type VatReportExportHeader } from "./epo-export-context";
import { prepareControlStatement, type EpoRow } from "./epo-values";
import { getVatReport } from "./vat-reports";
import { formatDate } from "@/lib/format-date";

const fontPath = path.join(
  process.cwd(),
  "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf",
);
const PAGE_SIZE: [number, number] = [595.28, 841.89];
const LEFT = 42;
const BOTTOM = 58;

export type ControlStatementPdfCopy = {
  title: string;
  vatId: string;
  ico: string;
  address: string;
  reportingPeriod: string;
  document: string;
  counterpartyVatId: string;
  counterpartyCountry: string;
  taxPointDate: string;
  supplyCode: string;
  section: string;
  rate: string;
  taxBaseCzk: string;
  vatCzk: string;
  sectionTotals: string;
  noEntries: string;
  statementTotals: string;
  subject: string;
};

function text(
  page: PDFPage,
  font: PDFFont,
  value: string,
  x: number,
  y: number,
  size = 10,
) {
  page.drawText(value, { x, y, size, font, color: rgb(0.08, 0.1, 0.13) });
}

function rightAligned(
  page: PDFPage,
  font: PDFFont,
  value: string,
  right: number,
  y: number,
  size = 10,
) {
  text(page, font, value, right - font.widthOfTextAtSize(value, size), y, size);
}

function pageHeader(
  document: PDFDocument,
  font: PDFFont,
  preview: ControlStatementPreviewData,
  copy: ControlStatementPdfCopy,
  firstPage: boolean,
) {
  const page = document.addPage(PAGE_SIZE);
  const right = page.getWidth() - LEFT;
  text(page, font, copy.title, LEFT, 798, 18);
  if (!firstPage) {
    text(page, font, preview.company.name, LEFT, 768, 11);
    text(
      page,
      font,
      `${copy.reportingPeriod}: ${preview.period}`,
      LEFT,
      748,
      10,
    );
    return { page, right, y: 716 };
  }
  text(page, font, preview.company.name, LEFT, 767, 13);
  text(page, font, `${copy.vatId}: ${preview.company.vatId}`, LEFT, 747);
  text(page, font, `${copy.ico}: ${preview.company.ico}`, LEFT, 731);
  text(
    page,
    font,
    `${copy.address}: ${registeredAddressLine(preview.company)}`,
    LEFT,
    715,
  );
  text(
    page,
    font,
    `${preview.company.postalCode} ${preview.company.city}`,
    LEFT + 48,
    699,
  );
  text(
    page,
    font,
    `${copy.reportingPeriod}: ${preview.period}`,
    LEFT,
    675,
    11,
  );
  return { page, right, y: 638 };
}

/** Renders a readable iVAT preview, not a replica of the official DPHKH1 form. */
export async function createControlStatementPdf(
  preview: ControlStatementPreviewData,
  copy: ControlStatementPdfCopy,
  filing?: { header: VatReportExportHeader; rows: EpoRow[] },
): Promise<Uint8Array> {
  if (filing) preview = { ...preview, company: pdfExportCompany(filing.header) };
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const font = await document.embedFont(await readFile(fontPath), {
    subset: true,
  });
  if (filing) {
    let { page, right, y } = pageHeader(document, font, preview, copy, true);
    const labels: Record<string, string> = {
      dic_odb: copy.counterpartyVatId, dic_dod: copy.counterpartyVatId,
      c_evid_dd: copy.document, duzp: copy.taxPointDate, dppd: copy.taxPointDate,
      k_stat: copy.counterpartyCountry, vatid_dod: copy.counterpartyVatId,
      kod_pred_pl: copy.supplyCode,
      ...Object.fromEntries((["c_radku", "kod_rezim_pl", "pomer", "zdph_44", "zakl_dane1", "dan1", "zakl_dane2", "dan2", "obrat23", "obrat5", "pln23", "pln5", "pln_rez_pren", "rez_pren23", "rez_pren5", "celk_zd_a2"] as const).map(key => [key, pdfFormText(`fields.${key}`)])),
    };
    for (const row of filing.rows) {
      const fields = Object.entries(row.attributes).filter((entry): entry is [string, string] => entry[1] !== undefined);
      const heading = row.name === "VetaC" ? pdfFormText("summary") : `${copy.section} ${row.name.slice(4, 5)}.${row.name.slice(5)}`;
      if (y - 48 < BOTTOM) ({ page, right, y } = pageHeader(document, font, preview, copy, false));
      text(page, font, heading, LEFT, y, 13);
      y -= 26;
      for (const [field, value] of fields) {
        if (y - 24 < BOTTOM) ({ page, right, y } = pageHeader(document, font, preview, copy, false));
        text(page, font, row.name === "VetaA1" && field === "zakl_dane1" ? copy.taxBaseCzk : labels[field], LEFT + 6, y);
        rightAligned(page, font, value, right - 6, y);
        y -= 24;
      }
      y -= 16;
    }
    appendPdfExportHeader(document, font, filing.header);
    document.setTitle(`${copy.title} ${preview.period} · ${preview.company.name}`);
    document.setSubject(copy.subject);
    return document.save();
  }
  let { page, right, y } = pageHeader(document, font, preview, copy, true);

  function columnHeader() {
    page.drawRectangle({ x: LEFT, y: y - 8, width: right - LEFT, height: 23, color: rgb(0.91, 0.94, 0.97) });
    text(page, font, copy.rate, LEFT + 6, y);
    rightAligned(page, font, copy.taxBaseCzk, right - 114, y);
    rightAligned(page, font, copy.vatCzk, right - 6, y);
    y -= 23;
  }
  function ensureSpace(height: number, continuingTable = false) {
    if (y - height >= BOTTOM) return;
    ({ page, right, y } = pageHeader(document, font, preview, copy, false));
    if (continuingTable) columnHeader();
  }
  function metadataOf(entry: ControlStatementPreviewData["sections"][number]["entries"][number]) {
    return [
      entry.documentNumber && `${copy.document}: ${entry.documentNumber}`,
      entry.counterpartyVatId && `${copy.counterpartyVatId}: ${entry.counterpartyVatId}`,
      entry.counterpartyCountry && `${copy.counterpartyCountry}: ${entry.counterpartyCountry}`,
      entry.taxPointDate && `${copy.taxPointDate}: ${formatDate(entry.taxPointDate)}`,
      entry.reverseChargeCode && `${copy.supplyCode}: ${entry.reverseChargeCode}`,
    ].filter((value): value is string => Boolean(value));
  }

  if (!preview.sections.length) {
    text(page, font, copy.noEntries, LEFT, y);
    y -= 30;
  }
  for (const section of preview.sections) {
    // Keep the heading/header (49pt) with the first entry's metadata and row (37pt).
    ensureSpace(86 + metadataOf(section.entries[0]).length * 16);
    text(page, font, `${copy.section} ${section.section}`, LEFT, y, 13);
    y -= 26;
    columnHeader();
    for (const entry of section.entries) {
      const metadata = metadataOf(entry);
      ensureSpace(metadata.length * 16 + 37, true);
      for (const line of metadata) {
        ensureSpace(16, true);
        text(page, font, line, LEFT + 6, y);
        y -= 16;
      }
      for (const rate of entry.rateBreakdown) {
        ensureSpace(23, true);
        text(page, font, `${rate.rate}%`, LEFT + 6, y);
        rightAligned(page, font, rate.netAmount, right - 114, y);
        rightAligned(page, font, rate.vatAmount, right - 6, y);
        page.drawLine({ start: { x: LEFT, y: y - 8 }, end: { x: right, y: y - 8 }, thickness: 0.5, color: rgb(0.78, 0.8, 0.83) });
        y -= 23;
      }
      y -= 14;
    }
    ensureSpace(35, true);
    text(page, font, copy.sectionTotals, LEFT + 6, y, 11);
    rightAligned(page, font, section.totals.netAmount, right - 114, y, 11);
    rightAligned(page, font, section.totals.vatAmount, right - 6, y, 11);
    y -= 36;
  }

  if (y - 70 < BOTTOM) {
    ({ page, right, y } = pageHeader(document, font, preview, copy, false));
  }
  text(page, font, copy.statementTotals, LEFT, y, 13);
  y -= 25;
  text(page, font, copy.taxBaseCzk, LEFT + 6, y);
  rightAligned(page, font, preview.totals.netAmount, right - 6, y);
  y -= 20;
  text(page, font, copy.vatCzk, LEFT + 6, y);
  rightAligned(page, font, preview.totals.vatAmount, right - 6, y);

  document.setTitle(`${copy.title} ${preview.period} · ${preview.company.name}`);
  document.setSubject(copy.subject);
  return document.save();
}

export type ControlStatementPdfDownload = {
  bytes: Uint8Array;
  fileName: string;
  mediaType: "application/pdf";
};

/** RLS scopes the saved snapshot before any PDF bytes are produced. */
export async function exportControlStatementPdf(
  client: AppClient,
  input: { companyId: string; period: string; details?: Record<string, string> },
  copy: ControlStatementPdfCopy,
  now: () => Date = () => new Date(),
): Promise<Result<ControlStatementPdfDownload, "report_not_found">> {
  const report = await getVatReport(client, input.companyId, input.period);
  if (!report) return { ok: false, error: "report_not_found" };
  return {
    ok: true,
    value: {
      bytes: await createControlStatementPdf(
        controlStatementPreviewData(report.result),
        copy,
        { rows: prepareControlStatement(report.result), header: {
          company: report.result.company, period: report.period,
          details: await resolveEpoExportDetails(client, { companyId: input.companyId, company: report.result.company, details: input.details ?? {}, today: todayInPrague(now()) }),
        } },
      ),
      fileName: `DPHKH1-${input.period}.pdf`,
      mediaType: "application/pdf",
    },
  };
}
