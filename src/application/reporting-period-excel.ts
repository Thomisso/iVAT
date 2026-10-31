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
import { loadStoredDocumentFindings, prepareDocumentReporting } from "./document-reporting";

export type ReportingPeriodWorkbookDownload = {
  bytes: Uint8Array;
  fileName: string;
  mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
};

export type ExportReportingPeriodWorkbookError = "forbidden" | "company_setup_incomplete" | "invalid_reporting_period";

type WorkbookDocument = ReportDocument & { findings: ValidationFinding[] };

const COLUMNS = [
  "Document ID",
  "Document number",
  "Direction",
  "Tax Point Date",
  "Counterparty",
  "VAT Regime",
  "VAT Return line",
  "Control Statement section",
  "VAT rate (%)",
  "Net amount",
  "VAT amount",
  "Gross amount",
  "Currency",
  "Status",
  "Findings",
  "Live inclusion",
  "Exclusion reason",
  "Exclusion detail",
  "Mapping status",
  "VAT Return mapping unavailable",
  "Control Statement mapping unavailable",
  "Blocking findings",
  "Advisory findings",
] as const;

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

function worksheet(rows: WorkbookRow[]): XLSX.WorkSheet {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: [...COLUMNS] });
  sheet["!cols"] = COLUMNS.map((column) => ({
    wch: column === "Document ID" ? 38 : column === "Findings" ? 52 : Math.max(14, column.length + 2),
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
        "Document ID": document.id,
        "Document number": values.documentNumber,
        Direction: values.direction,
        "Tax Point Date": values.taxPointDate,
        Counterparty: values.counterparty,
        "VAT Regime": values.vatRegime,
        "VAT Return line": reporting.mapping.vatReturnLines.join(", "),
        "Control Statement section": reporting.mapping.controlStatementSection ?? "",
        "VAT rate (%)": values.rate,
        "Net amount": values.netAmount,
        "VAT amount": values.vatAmount,
        "Gross amount": values.grossAmount,
        Currency: values.currency,
        Status: document.status,
        Findings: findingText,
        "Live inclusion": reporting.included ? "included" : "excluded",
        "Exclusion reason": reporting.exclusionReason ?? "",
        "Exclusion detail": reporting.exclusionDetail ?? "",
        "Mapping status": reporting.included ? "included" : reporting.mapping.vatReturnLines.length || reporting.mapping.controlStatementSection ? "proposed" : "unavailable",
        "VAT Return mapping unavailable": reporting.mapping.vatReturnUnknownReason ?? "",
        "Control Statement mapping unavailable": reporting.mapping.controlStatementUnknownReason ?? "",
        "Blocking findings": findings(reporting.blockingFindings),
        "Advisory findings": findings(reporting.advisoryFindings),
      };
      if (reporting.included) included.push(row);
      if (!reporting.included || findingText) attention.push(row);
    }
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet(included), "Included");
  XLSX.utils.book_append_sheet(workbook, worksheet(attention), "Attention");
  return {
    ok: true,
    value: {
      bytes: new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "buffer", compression: true })),
      fileName: `VAT-overview-${input.period}.xlsx`,
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  };
}
