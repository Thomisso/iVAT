import * as XLSX from "xlsx";
import type { ValidationFinding } from "./document-validation";
import { isZeroRateBreakdownLine, type ExtractionPayload, type DraftRateBreakdownLine } from "./extraction-payload";
import {
  getCompany,
  getCompanySetupChecklist,
  getReportingPeriodFrequency,
  listCompanyReportingYears,
} from "./companies";
import type { AppClient, Result } from "./client";
import { isReportingPeriod, type ReportDocument } from "./vat-rules";
import { loadStoredDocumentFindings, prepareDocumentReporting, type DocumentReporting } from "./document-reporting";

export type ReportingPeriodWorkbookDownload = {
  bytes: Uint8Array;
  fileName: string;
  mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
};

export type ExportReportingPeriodWorkbookError = "forbidden" | "company_setup_incomplete" | "invalid_reporting_period";

type WorkbookDocument = ReportDocument & { findings: ValidationFinding[] };

const COLUMNS = [
  "documentId",
  "documentNumber",
  "direction",
  "taxPointDate",
  "counterparty",
  "vatRegime",
  "vatReturnLine",
  "controlStatementSection",
  "vatRate",
  "netAmount",
  "vatAmount",
  "grossAmount",
  "currency",
  "status",
  "findings",
  "liveInclusion",
  "exclusionReason",
  "exclusionDetail",
  "mappingStatus",
  "vatReturnUnavailable",
  "controlStatementUnavailable",
  "blockingFindings",
  "advisoryFindings",
] as const;

export type ReportingPeriodWorkbookCopy = {
  columns: Record<(typeof COLUMNS)[number], string>;
  sheets: { included: string; attention: string };
  fileNamePrefix: string;
  inclusion: { included: string; excluded: string };
  mapping: { included: string; proposed: string; unavailable: string };
  reasons: Record<NonNullable<DocumentReporting["exclusionReason"]>, string>;
  details: Record<NonNullable<DocumentReporting["exclusionDetail"]>, string>;
  unknownReasons: Record<NonNullable<DocumentReporting["mapping"]["vatReturnUnknownReason"]>, string>;
};

type WorkbookRow = Record<(typeof COLUMNS)[number], string | number>;

function amount(value: string | null): string | number {
  if (value === null) return "";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

function rateGross(line: DraftRateBreakdownLine | null): string | number {
  if (!line || line.netAmount === null || line.vatAmount === null) return "";
  const net = Number(line.netAmount);
  const vat = Number(line.vatAmount);
  return Number.isFinite(net) && Number.isFinite(vat) ? net + vat : "";
}

function details(payload: ExtractionPayload | null, line: DraftRateBreakdownLine | null) {
  if (!payload) {
    return {
      documentNumber: "",
      direction: "",
      taxPointDate: "",
      counterparty: "",
      vatRegime: "",
      rate: "",
      netAmount: "",
      vatAmount: "",
      grossAmount: "",
      currency: "",
    };
  }
  const counterparty = payload.direction === "incoming"
    ? payload.supplier
    : payload.direction === "outgoing"
      ? payload.customer
      : null;
  return {
    documentNumber: payload.documentNumber ?? "",
    direction: payload.direction ?? "",
    taxPointDate: payload.taxPointDate ?? "",
    counterparty: counterparty?.name ?? counterparty?.vatId ?? "",
    vatRegime: payload.proposedVatRegime ?? "",
    rate: line?.rate ?? "",
    netAmount: line ? amount(line.netAmount) : "",
    vatAmount: line ? amount(line.vatAmount) : "",
    grossAmount: rateGross(line),
    currency: payload.currency ?? "",
  };
}

function findings(values: readonly ValidationFinding[]): string {
  return values
    .map((finding) => `${finding.severity}: ${finding.code} (${finding.field})`)
    .join("; ");
}

function worksheet(rows: WorkbookRow[], copy: ReportingPeriodWorkbookCopy): XLSX.WorkSheet {
  const sheet = XLSX.utils.aoa_to_sheet([COLUMNS.map(column => copy.columns[column]), ...rows.map(row => COLUMNS.map(column => row[column]))]);
  sheet["!cols"] = COLUMNS.map((column) => ({
    wch: column === "documentId" ? 38 : column === "findings" ? 52 : Math.max(14, copy.columns[column].length + 2),
  }));
  sheet["!autofilter"] = { ref: sheet["!ref"] ?? `A1:${XLSX.utils.encode_col(COLUMNS.length - 1)}1` };
  for (let row = 1; row <= rows.length; row++) {
    for (const column of [9, 10, 11]) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell?.t === "n") cell.z = "#,##0.00";
    }
  }
  return sheet;
}

/** Builds a current-data overview for checking a Reporting Period before generation. */
export async function exportReportingPeriodWorkbook(
  client: AppClient,
  input: { companyId: string; period: string },
  copy: ReportingPeriodWorkbookCopy,
): Promise<Result<ReportingPeriodWorkbookDownload, ExportReportingPeriodWorkbookError>> {
  if (!isReportingPeriod(input.period)) return { ok: false, error: "invalid_reporting_period" };
  const company = await getCompany(client, input.companyId);
  if (!company) return { ok: false, error: "forbidden" };
  const setup = await getCompanySetupChecklist(client, company.id);
  if (setup.some((item) => (item.step === "identity" || item.step === "filing_frequency") && item.state !== "completed")) {
    return { ok: false, error: "company_setup_incomplete" };
  }
  const frequency = await getReportingPeriodFrequency(client, company.id, input.period);
  if (
    frequency === null
    || (input.period.includes("-Q") ? frequency !== "quarterly" : frequency !== "monthly")
  ) {
    return { ok: false, error: "invalid_reporting_period" };
  }
  const [{ data, error }, reportingYears] = await Promise.all([
    client.rpc("vat_report_documents", {
      target_company_id: company.id,
      target_period: input.period,
    }),
    listCompanyReportingYears(client, company.id),
  ]);
  if (error) throw error;
  const reportDocuments = data as unknown as ReportDocument[];
  const findingsByVersion = await loadStoredDocumentFindings(client, reportDocuments);
  const documents: WorkbookDocument[] = reportDocuments.map((document) => ({
    ...document,
    findings: document.extractionVersionId ? findingsByVersion.get(document.extractionVersionId) ?? [] : [],
  }));
  const included: WorkbookRow[] = [];
  const attention: WorkbookRow[] = [];
  for (const document of documents) {
    const reporting = prepareDocumentReporting(document, reportingYears, input.period, document.findings);
    const findingText = findings([...reporting.blockingFindings, ...reporting.advisoryFindings]);
    const meaningfulRates = document.payload?.rateBreakdown.filter((line) => !isZeroRateBreakdownLine(line)) ?? [];
    const rates = meaningfulRates.length ? meaningfulRates : [null];
    for (const rate of rates) {
      const values = details(document.payload, rate);
      const row: WorkbookRow = {
        "documentId": document.id,
        "documentNumber": values.documentNumber,
        direction: values.direction,
        "taxPointDate": values.taxPointDate,
        counterparty: values.counterparty,
        "vatRegime": values.vatRegime,
        "vatReturnLine": reporting.mapping.vatReturnLines.join(", "),
        "controlStatementSection": reporting.mapping.controlStatementSection ?? "",
        "vatRate": values.rate,
        "netAmount": values.netAmount,
        "vatAmount": values.vatAmount,
        "grossAmount": values.grossAmount,
        currency: values.currency,
        status: document.status,
        findings: findingText,
        "liveInclusion": reporting.included ? copy.inclusion.included : copy.inclusion.excluded,
        "exclusionReason": reporting.exclusionReason ? copy.reasons[reporting.exclusionReason] : "",
        "exclusionDetail": reporting.exclusionDetail ? copy.details[reporting.exclusionDetail] : "",
        "mappingStatus": reporting.included ? copy.mapping.included : reporting.mapping.vatReturnLines.length || reporting.mapping.controlStatementSection ? copy.mapping.proposed : copy.mapping.unavailable,
        "vatReturnUnavailable": reporting.mapping.vatReturnUnknownReason ? copy.unknownReasons[reporting.mapping.vatReturnUnknownReason] : "",
        "controlStatementUnavailable": reporting.mapping.controlStatementUnknownReason ? copy.unknownReasons[reporting.mapping.controlStatementUnknownReason] : "",
        "blockingFindings": findings(reporting.blockingFindings),
        "advisoryFindings": findings(reporting.advisoryFindings),
      };
      if (reporting.included) included.push(row);
      if (!reporting.included || findingText) attention.push(row);
    }
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet(included, copy), copy.sheets.included);
  XLSX.utils.book_append_sheet(workbook, worksheet(attention, copy), copy.sheets.attention);
  return {
    ok: true,
    value: {
      bytes: new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "buffer", compression: true })),
      fileName: `${copy.fileNamePrefix}-${input.period}.xlsx`,
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  };
}
