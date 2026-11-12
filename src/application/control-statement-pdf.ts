import { archiveVatReportPdf, type PdfArtifactError } from "./vat-report-pdf-artifacts";
import { CONTROL_STATEMENT_DETAILS } from "./control-statement-form";
import { PDFDocument } from "pdf-lib";
import type { AppClient, Result } from "./client";
import { getVatReportExportHeader, resolveEpoExportDetails, todayInPrague, type VatReportExportHeader } from "./epo-export-context";
import { prepareControlStatement, type EpoRow } from "./epo-values";
import { getVatReport } from "./vat-reports";
import { drawFormCell, drawFormHeader, embedFormFont, loadFormAsset } from "./pdf-form";

// Retained for existing callers; statutory form content is always Czech.
export type ControlStatementPdfCopy = Record<"title" | "vatId" | "ico" | "address" | "reportingPeriod" | "document" | "counterpartyVatId" | "counterpartyCountry" | "taxPointDate" | "supplyCode" | "section" | "rate" | "taxBaseCzk" | "vatCzk" | "sectionTotals" | "noEntries" | "statementTotals" | "subject", string>;
export type ControlStatementPdfDownload = { bytes: Uint8Array; artifactId?: string; fileName: string; mediaType: "application/pdf" };

/** Complete output and header-only preview reuse the exact opening artwork. */
async function openingForm(header: VatReportExportHeader) {
  const template = await PDFDocument.load(await loadFormAsset("control-statement.pdf"));
  const document = await PDFDocument.create();
  const font = await embedFormFont(document);
  const [opening] = await document.copyPages(template, [0]);
  document.addPage(opening);
  drawFormHeader(opening, font, header, "control-statement");
  document.setTitle(`Kontrolní hlášení ${header.period} · ${header.company.name}`);
  return { template, document, font };
}

export async function createControlStatementPdf(header: VatReportExportHeader, rows: EpoRow[]): Promise<Uint8Array> {
  const { template, document, font } = await openingForm(header);
  const totalPages = 2 + CONTROL_STATEMENT_DETAILS.reduce((sum, section) => sum + Math.ceil(rows.filter(row => row.name === section.name).length / (section.rows.length - 1)), 0);
  for (const section of CONTROL_STATEMENT_DETAILS) {
    const entries = rows.filter(row => row.name === section.name);
    const capacity = section.rows.length - 1;
    for (let start = 0; start < entries.length; start += capacity) {
      const [page] = await document.copyPages(template, [section.template]);
      document.addPage(page);
      const [left, top, right, bottom] = section.pageNumber;
      const middle = (left + right) / 2;
      if (section.name === "VetaA1") drawFormCell(page, font, "/", [middle - 6, top, middle + 6, bottom], { align: "center" });
      drawFormCell(page, font, String(document.getPageCount()), [left, top, middle - 3, bottom], { align: "center" });
      drawFormCell(page, font, String(totalPages), [middle + 3, top, right, bottom], { align: "center" });
      entries.slice(start, start + capacity).forEach((entry, index) => {
        const values: EpoRow["attributes"] = { ...entry.attributes, supplierVatId: `${entry.attributes.k_stat ?? ""}${entry.attributes.vatid_dod ?? ""}` };
        section.fields.forEach((field, column) => {
          if (!field) return;
          drawFormCell(page, font, values[field], [section.columns[column], section.rows[index], section.columns[column + 1], section.rows[index + 1]], { align: /^(zakl_dane|dan)/.test(field) ? "right" : field === "c_evid_dd" ? "left" : "center", size: 8 });
        });
      });
    }
  }
  const [summary] = await document.copyPages(template, [6]);
  document.addPage(summary);
  drawFormCell(summary, font, String(totalPages), [502.4, 21.3, 528.4, 38.1], { align: "center" });
  drawFormCell(summary, font, String(totalPages), [534.4, 21.3, 560.5, 38.1], { align: "center" });
  const aggregateColumns = [26.8, 116.5, 206.2, 295.6, 385.1, 474.1, 563.9];
  for (const [name, top] of [["VetaA5", 140.04], ["VetaB3", 278.04]] as const) {
    const aggregate = rows.find(row => row.name === name)?.attributes;
    ["zakl_dane1", "dan1", "zakl_dane2", "dan2"].forEach((key, index) => drawFormCell(summary, font, aggregate?.[key], [aggregateColumns[index], top, aggregateColumns[index + 1], top + 28.29], { align: "right" }));
  }
  const values = rows.find(row => row.name === "VetaC")?.attributes ?? {};
  for (const [index, key] of ["obrat23", "obrat5", "pln23", "pln5", "pln_rez_pren", "rez_pren23", "rez_pren5", "celk_zd_a2"].entries()) {
    const top = 376.24 + index * 20.03;
    drawFormCell(summary, font, values[key], [445.92, top, 563.9, top + 19.5], { align: "right" });
  }
  return document.save();
}

/** RLS scopes the saved report before any complete PDF bytes are produced. */
export async function exportControlStatementPdf(client: AppClient, input: { companyId: string; period: string; details?: Record<string, string> }, _copy: ControlStatementPdfCopy | undefined, now: () => Date = () => new Date()): Promise<Result<ControlStatementPdfDownload, "report_not_found" | "invalid_representative" | PdfArtifactError>> {
  const report = await getVatReport(client, input.companyId, input.period);
  if (!report) return { ok: false, error: "report_not_found" };
  const details = await resolveEpoExportDetails(client, { companyId: input.companyId, company: report.result.company, details: input.details ?? {}, today: todayInPrague(now()) });
  if (!details.ok) return details;
  const header = { company: report.result.company, period: report.period, details: details.value };
  const bytes = await createControlStatementPdf(header, prepareControlStatement(report.result));
  const archived = await archiveVatReportPdf(client, { companyId: input.companyId, reportId: report.id, reportGeneratedAt: report.generatedAt, format: "dphkh1", bytes, details: details.value });
  if (!archived.ok) return archived;
  return { ok: true, value: { bytes, artifactId: archived.value, fileName: `DPHKH1-${input.period}.pdf`, mediaType: "application/pdf" } };
}

/** No EPO rows, pagination or full-document exporter are involved in this path. */
export async function exportControlStatementThumbnail(client: AppClient, input: { companyId: string; period: string; details?: Record<string, string> }, now: () => Date = () => new Date()): Promise<Result<ControlStatementPdfDownload, "report_not_found" | "invalid_representative">> {
  const header = await getVatReportExportHeader(client, input, now);
  if (!header.ok) return header;
  return { ok: true, value: { bytes: await (await openingForm(header.value)).document.save(), fileName: `DPHKH1-${input.period}-thumbnail.pdf`, mediaType: "application/pdf" } };
}
