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
import { getVatReport } from "./vat-reports";

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
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const font = await document.embedFont(await readFile(fontPath), {
    subset: true,
  });
  let { page, right, y } = pageHeader(document, font, preview, copy, true);

  for (const entry of preview.entries) {
    const metadataLines = [
      entry.documentNumber && `${copy.document}: ${entry.documentNumber}`,
      entry.counterpartyVatId &&
        `${copy.counterpartyVatId}: ${entry.counterpartyVatId}`,
      entry.counterpartyCountry &&
        `${copy.counterpartyCountry}: ${entry.counterpartyCountry}`,
      entry.taxPointDate && `${copy.taxPointDate}: ${entry.taxPointDate}`,
      entry.reverseChargeCode &&
        `${copy.supplyCode}: ${entry.reverseChargeCode}`,
    ].filter((value): value is string => Boolean(value));
    const requiredHeight =
      58 + metadataLines.length * 16 + entry.rateBreakdown.length * 23;
    if (y - requiredHeight < BOTTOM) {
      ({ page, right, y } = pageHeader(document, font, preview, copy, false));
    }

    text(page, font, `${copy.section} ${entry.section}`, LEFT, y, 13);
    y -= 21;
    for (const metadata of metadataLines) {
      text(page, font, metadata, LEFT + 6, y);
      y -= 16;
    }

    page.drawRectangle({
      x: LEFT,
      y: y - 8,
      width: right - LEFT,
      height: 23,
      color: rgb(0.91, 0.94, 0.97),
    });
    text(page, font, copy.rate, LEFT + 6, y);
    rightAligned(page, font, copy.taxBaseCzk, right - 114, y);
    rightAligned(page, font, copy.vatCzk, right - 6, y);
    y -= 23;
    for (const rate of entry.rateBreakdown) {
      text(page, font, `${rate.rate}%`, LEFT + 6, y);
      rightAligned(page, font, rate.netAmount, right - 114, y);
      rightAligned(page, font, rate.vatAmount, right - 6, y);
      page.drawLine({
        start: { x: LEFT, y: y - 8 },
        end: { x: right, y: y - 8 },
        thickness: 0.5,
        color: rgb(0.78, 0.8, 0.83),
      });
      y -= 23;
    }
    y -= 14;
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
  input: { companyId: string; period: string },
  copy: ControlStatementPdfCopy,
): Promise<Result<ControlStatementPdfDownload, "report_not_found">> {
  const report = await getVatReport(client, input.companyId, input.period);
  if (!report) return { ok: false, error: "report_not_found" };
  return {
    ok: true,
    value: {
      bytes: await createControlStatementPdf(
        controlStatementPreviewData(report.result),
        copy,
      ),
      fileName: `DPHKH1-${input.period}.pdf`,
      mediaType: "application/pdf",
    },
  };
}
