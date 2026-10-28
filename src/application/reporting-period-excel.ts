import * as XLSX from "xlsx";
import type { ValidationFinding } from "./document-validation";
import type { ExtractionPayload, RateBreakdownLine } from "./extraction-payload";
import { type CompanyDetails, getCompany } from "./companies";
import type { AppClient, Result } from "./client";
import { computeVatReport, isReportingPeriod, type ReportDocument } from "./vat-rules";

export type ReportingPeriodWorkbookDownload = {
  bytes: Uint8Array;
  fileName: string;
  mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
};

export type ExportReportingPeriodWorkbookError = "forbidden" | "invalid_reporting_period";

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
] as const;

type WorkbookRow = Record<(typeof COLUMNS)[number], string | number>;

function amount(value: string | null): string | number {
  if (value === null) return "";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

function rateGross(line: RateBreakdownLine | null): string | number {
  if (!line) return "";
  const net = Number(line.netAmount);
  const vat = Number(line.vatAmount);
  return Number.isFinite(net) && Number.isFinite(vat) ? net + vat : "";
}

function details(payload: ExtractionPayload | null, line: RateBreakdownLine | null) {
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

function findings(document: WorkbookDocument): string {
  return document.findings
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

async function currentFindings(client: AppClient, documents: ReportDocument[]): Promise<Map<string, ValidationFinding[]>> {
  const versionIds = documents.flatMap((document) => document.extractionVersionId ? [document.extractionVersionId] : []);
  const byVersion = new Map<string, ValidationFinding[]>();
  for (let offset = 0; offset < versionIds.length; offset += 500) {
    const { data, error } = await client
      .from("extraction_version")
      .select("id, findings")
      .in("id", versionIds.slice(offset, offset + 500));
    if (error) throw error;
    for (const version of data) byVersion.set(version.id, version.findings as ValidationFinding[]);
  }
  return byVersion;
}

/** Builds a current-data overview for checking a Reporting Period before generation. */
export async function exportReportingPeriodWorkbook(
  client: AppClient,
  input: { companyId: string; period: string },
): Promise<Result<ReportingPeriodWorkbookDownload, ExportReportingPeriodWorkbookError>> {
  if (!isReportingPeriod(input.period)) return { ok: false, error: "invalid_reporting_period" };
  const company = await getCompany(client, input.companyId);
  if (!company) return { ok: false, error: "forbidden" };
  const { data, error } = await client.rpc("vat_report_documents", {
    target_company_id: company.id,
    target_period: input.period,
  });
  if (error) throw error;
  const reportDocuments = data as unknown as ReportDocument[];
  const findingsByVersion = await currentFindings(client, reportDocuments);
  const documents: WorkbookDocument[] = reportDocuments.map((document) => ({
    ...document,
    findings: document.extractionVersionId ? findingsByVersion.get(document.extractionVersionId) ?? [] : [],
  }));
  const companyDetails: CompanyDetails = {
    name: company.name,
    ico: company.ico,
    vatId: company.vatId,
    street: company.street,
    city: company.city,
    postalCode: company.postalCode,
    personType: company.personType,
  };
  const report = computeVatReport(companyDetails, input.period, documents);
  const returnLines = new Map(documents.map((document) => [
    document.id,
    report.vatReturn.filter((line) => line.documentIds.includes(document.id)).map((line) => line.line).join(", "),
  ]));
  const statementSections = new Map(documents.map((document) => [
    document.id,
    [...new Set(report.controlStatement
      .filter((entry) => entry.documentIds.includes(document.id))
      .map((entry) => entry.section))].join(", "),
  ]));
  const exclusions = new Map(report.excludedDocuments.map((excluded) => [excluded.documentId, excluded.reason]));
  const included: WorkbookRow[] = [];
  const attention: WorkbookRow[] = [];
  for (const document of documents) {
    const findingText = findings(document);
    const target = document.status === "approved" && !findingText && !exclusions.has(document.id)
      ? included
      : attention;
    const rates = document.payload?.rateBreakdown.length ? document.payload.rateBreakdown : [null];
    for (const rate of rates) {
      const values = details(document.payload, rate);
      target.push({
        "Document ID": document.id,
        "Document number": values.documentNumber,
        Direction: values.direction,
        "Tax Point Date": values.taxPointDate,
        Counterparty: values.counterparty,
        "VAT Regime": values.vatRegime,
        "VAT Return line": returnLines.get(document.id) ?? "",
        "Control Statement section": statementSections.get(document.id) ?? "",
        "VAT rate (%)": values.rate,
        "Net amount": values.netAmount,
        "VAT amount": values.vatAmount,
        "Gross amount": values.grossAmount,
        Currency: values.currency,
        Status: document.status,
        Findings: findingText,
      });
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
