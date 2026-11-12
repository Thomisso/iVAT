import { archiveVatReportPdf, type PdfArtifactError } from "./vat-report-pdf-artifacts";
import { PDFDocument } from "pdf-lib";
import type { AppClient, Result } from "./client";
import type { VatReturnPreviewData } from "./vat-return-preview";
import { prepareVatReturn } from "./epo-values";
import { getVatReportExportHeader, resolveEpoExportDetails, todayInPrague, type VatReportExportHeader } from "./epo-export-context";
import { getVatReport } from "./vat-reports";
import { drawFormCell, drawFormHeader, embedFormFont, loadFormAsset } from "./pdf-form";

async function openingForm(header: VatReportExportHeader) {
  const document = await PDFDocument.create();
  const template = await PDFDocument.load(await loadFormAsset("vat-return.pdf"));
  const [page] = await document.copyPages(template, [0]);
  document.addPage(page);
  const font = await embedFormFont(document);
  drawFormHeader(page, font, header, "vat-return");
  return { document, template, font, page };
}

/** Complete statutory form, using exactly the same prepared rows as XML. */
export async function createVatReturnPdf(preview: VatReturnPreviewData, header?: VatReportExportHeader): Promise<Uint8Array> {
  header ??= { company: preview.company, period: preview.period, details: {
    personType: preview.company.personType === "natural" ? "F" : "P",
    taxOffice: "", territorialOffice: "", economicActivity: "", preparedOn: "", email: "", phone: "",
    signatoryFirstName: "", signatoryLastName: "", signatoryCapacity: "", address: preview.company,
  } };
  const { document, template, font, page } = await openingForm(header);
  if (!preview.lines.some(line => line.documentIds.length)) drawFormCell(page, font, "X", [538, 300.8, 566.7, 317.6], { align: "center", size: 12 });
  const [amounts] = await document.copyPages(template, [1]);
  document.addPage(amounts);
  const rows = prepareVatReturn({ vatReturn: preview.lines }).rows;
  const values = Object.assign({}, ...rows.map(row => row.attributes)) as Record<string, string | undefined>;
  const amount = (key: string, left: number, top: number, right: number, bottom: number) => drawFormCell(amounts, font, values[key], [left, top, right, bottom], { align: "right", size: 10 });
  for (const [top, base, vat] of [
    [59.64, "obrat23", "dan23"], [73.81, "obrat5", "dan5"],
    [87.98, "p_zb23", "dan_pzb23"], [102.16, "p_zb5", "dan_pzb5"],
    [116.33, "p_sl23_e", "dan_psl23_e"], [130.50, "p_sl5_e", "dan_psl5_e"],
    [187.20, "rez_pren23", "dan_rpren23"], [201.37, "rez_pren5", "dan_rpren5"],
  ] as const) {
    amount(base, 283.46, top, 418.01, top + 14.17);
    amount(vat, 418.01, top, 551.24, top + 14.17);
  }
  for (const [top, base, vat] of [
    [479.17, "pln23", "odp_tuz23_nar"], [493.34, "pln5", "odp_tuz5_nar"],
    [521.68, "nar_zdp23", "od_zdp23"], [535.86, "nar_zdp5", "od_zdp5"],
  ] as const) {
    amount(base, 283.46, top, 378.32, top + 14.17);
    amount(vat, 378.32, top, 464.82, top + 14.17);
  }
  amount("odp_sum_nar", 378.32, 564.20, 464.82, 578.38);
  for (const [top, key] of [[345.94, "pln_rez_pren"], [739.95, "dan_zocelk"], [754.13, "odp_zocelk"], [768.30, "dano_da"], [782.47, "dano_no"]] as const) amount(key, 418.01, top, 551.24, top + 14.17);
  document.setTitle(`Přiznání k DPH ${preview.period} · ${preview.company.name}`);
  return document.save();
}

/** Header-only preparation: never prepares amount rows or the second page. */
export async function exportVatReturnThumbnail(client: AppClient, input: { companyId: string; period: string; details?: Record<string, string> }, now: () => Date = () => new Date()): Promise<Result<VatReturnPdfDownload, "report_not_found" | "invalid_representative">> {
  const header = await getVatReportExportHeader(client, input, now);
  if (!header.ok) return header;
  const { document } = await openingForm(header.value);
  return { ok: true, value: { bytes: await document.save(), fileName: `DPHDP3-${input.period}-thumbnail.pdf`, mediaType: "application/pdf" } };
}

export type VatReturnPdfDownload = {
  bytes: Uint8Array;
  artifactId?: string;
  fileName: string;
  mediaType: "application/pdf";
};

/** RLS scopes the saved snapshot before any PDF bytes are produced. */
export async function exportVatReturnPdf(
  client: AppClient,
  input: { companyId: string; period: string; details?: Record<string, string> },
  now: () => Date = () => new Date(),
): Promise<Result<VatReturnPdfDownload, "report_not_found" | "invalid_representative" | PdfArtifactError>> {
  const report = await getVatReport(client, input.companyId, input.period);
  if (!report) return { ok: false, error: "report_not_found" };
  const details = await resolveEpoExportDetails(client, { companyId: input.companyId, company: report.result.company, details: input.details ?? {}, today: todayInPrague(now()) });
  if (!details.ok) return details;
  const bytes = await createVatReturnPdf({ company: report.result.company, period: report.period, lines: report.result.vatReturn, totals: report.result.totals }, {
    company: report.result.company, period: report.period, details: details.value,
  });
  const archived = await archiveVatReportPdf(client, { companyId: input.companyId, reportId: report.id, reportGeneratedAt: report.generatedAt, format: "dphdp3", bytes, details: details.value });
  if (!archived.ok) return archived;
  return { ok: true, value: { bytes, artifactId: archived.value, fileName: `DPHDP3-${input.period}.pdf`, mediaType: "application/pdf" } };
}
