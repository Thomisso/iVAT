import { currentValidationFindings } from "./document-validation";
import type { AppClient, Result } from "./client";
import { isUuid } from "./client";
import {
  getCompany,
  getReportingPeriodFrequency,
  listCompanyReportingYears,
} from "./companies";
import type { ValidationFinding } from "./document-validation";
import { listCompanyDocuments } from "./documents";
import {
  isReportingPeriod,
  reportingPeriodForDate,
  reportingPeriodGapFinding,
  reportingPeriodsOf,
} from "./reporting-periods";
import type { ReportDocument } from "./vat-rules";

export type ReportingPeriodSummary = {
  period: string;
  frequency: "monthly" | "quarterly";
  generatedAt: string | null;
  lockedAt: string | null;
  state: "unfinished" | "draft" | "finalized";
  oldestUnfinished: boolean;
};

export type ReadinessFindingCode =
  | "processing"
  | "failed"
  | "needs_review"
  | "missing_direction"
  | "missing_tax_point_date"
  | "missing_rate"
  | "missing_currency"
  | "error_finding"
  | "warning_finding";

export type ReadinessFinding = {
  code: ReadinessFindingCode;
  documentId: string;
  findingCode?: string;
};

export type ReportingPeriodReadiness = {
  companyId: string;
  period: string;
  ready: boolean;
  blockers: ReadinessFinding[];
  warnings: ReadinessFinding[];
  groups: {
    processing: string[];
    failed: string[];
    needsReview: string[];
    rejected: string[];
    approved: string[];
  };
  source: ReportingPeriodReadinessSource[];
  snapshot: {
    reportId: string;
    generatedAt: string;
    freshness: "current" | "stale";
  } | null;
};

export type ReportingPeriodReadinessSource = {
  documentId: string;
  status: ReportDocument["status"];
  extractionVersionId: string | null;
  claimedReportingPeriod: string | null;
};

export type ReportingPeriodReadinessError =
  | "forbidden"
  | "invalid_reporting_period";

export const READINESS_DOCUMENT_FILTERS = ["blockers", "warnings", "rejected"] as const;
export type ReadinessDocumentFilter = (typeof READINESS_DOCUMENT_FILTERS)[number];

/** Unique Documents represented by one readiness summary or resolved exclusion. */
export function readinessDocumentIds(
  readiness: ReportingPeriodReadiness,
  filter: ReadinessDocumentFilter,
): string[] {
  const ids = filter === "rejected"
    ? readiness.groups.rejected
    : readiness[filter].map((finding) => finding.documentId);
  return [...new Set(ids)];
}

export function readinessDocumentCounts(readiness: ReportingPeriodReadiness) {
  return {
    blockers: readinessDocumentIds(readiness, "blockers").length,
    warnings: readinessDocumentIds(readiness, "warnings").length,
    rejected: readinessDocumentIds(readiness, "rejected").length,
  };
}

type LiveDocument = ReportDocument & { findings: ValidationFinding[] };
type SavedSourceSnapshot = {
  id: string;
  generatedAt: string;
  documents: ReportDocument[];
  readinessSource: ReportingPeriodReadinessSource[] | null;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameSourceSnapshot(report: SavedSourceSnapshot, documents: ReportDocument[]) {
  return canonical(report.documents) === canonical(documents);
}

function snapshotIsCurrent(
  report: SavedSourceSnapshot,
  assigned: ReportDocument[],
  relevant: ReportDocument[],
  source: ReportingPeriodReadinessSource[],
) {
  if (report.readinessSource) {
    return canonical(report.readinessSource) === canonical(source);
  }
  const assignedIds = new Set(assigned.map((document) => document.id));
  return sameSourceSnapshot(report, assigned) && relevant.every((document) =>
    assignedIds.has(document.id) || document.status === "rejected",
  );
}

function readinessSource(
  documents: ReportDocument[],
): ReportingPeriodReadinessSource[] {
  return documents.map((document) => ({
    documentId: document.id,
    status: document.status,
    extractionVersionId: document.extractionVersionId,
    claimedReportingPeriod: document.claimedReportingPeriod ?? null,
  }));
}

async function getSavedSourceSnapshot(
  client: AppClient,
  companyId: string,
  period: string,
): Promise<SavedSourceSnapshot | null> {
  const { data, error } = await client
    .from("vat_report")
    .select("id, generated_at, documents, result")
    .eq("company_id", companyId)
    .eq("period", period)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const result = data.result as { readinessSource?: unknown };
  return {
    id: data.id,
    generatedAt: data.generated_at,
    documents: data.documents as unknown as ReportDocument[],
    readinessSource: Array.isArray(result.readinessSource)
      ? result.readinessSource as ReportingPeriodReadinessSource[]
      : null,
  };
}

/** Lists the Reporting Periods of the Company's generated Reporting Years and identifies the oldest period without a lock. */
export async function listReportingPeriods(
  client: AppClient,
  companyId: string,
): Promise<ReportingPeriodSummary[]> {
  if (!isUuid(companyId)) return [];
  const company = await getCompany(client, companyId);
  if (!company) return [];
  const periods = reportingPeriodsOf(await listCompanyReportingYears(client, companyId));
  if (periods.length === 0) return [];

  const reports: { period: string; generated_at: string }[] = [];
  const locks: { period: string; locked_at: string }[] = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await client
      .from("vat_report")
      .select("period, generated_at")
      .eq("company_id", companyId)
      .order("period")
      .range(offset, offset + 999);
    if (error) throw error;
    reports.push(...data);
    if (data.length < 1_000) break;
  }
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await client
      .from("period_lock")
      .select("period, locked_at")
      .eq("company_id", companyId)
      .order("period")
      .range(offset, offset + 999);
    if (error) throw error;
    locks.push(...data);
    if (data.length < 1_000) break;
  }
  const reportByPeriod = new Map(reports.map((report) => [report.period, report]));
  const lockByPeriod = new Map(locks.map((lock) => [lock.period, lock]));
  const oldestUnfinished = periods.find((period) => !lockByPeriod.has(period));
  return periods.map((period) => {
    const report = reportByPeriod.get(period);
    const lock = lockByPeriod.get(period);
    return {
      period,
      frequency: period.includes("-Q") ? "quarterly" : "monthly",
      generatedAt: report?.generated_at ?? null,
      lockedAt: lock?.locked_at ?? null,
      state: lock ? "finalized" : report ? "draft" : "unfinished",
      oldestUnfinished: period === oldestUnfinished,
    };
  });
}

async function findingsByVersion(
  client: AppClient,
  documents: ReportDocument[],
): Promise<Map<string, ValidationFinding[]>> {
  const ids = [...new Set(documents.flatMap((document) =>
    document.extractionVersionId ? [document.extractionVersionId] : [],
  ))];
  const result = new Map<string, ValidationFinding[]>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const { data, error } = await client
      .from("extraction_version")
      .select("id, payload, findings")
      .in("id", ids.slice(offset, offset + 100));
    if (error) throw error;
    for (const version of data) {
      result.set(version.id, currentValidationFindings(
        version.payload as unknown as NonNullable<ReportDocument["payload"]>,
        version.findings as ValidationFinding[],
      ));
    }
  }
  return result;
}

async function relevantDocuments(
  client: AppClient,
  companyId: string,
  period: string,
  reportingYears: Awaited<ReturnType<typeof listCompanyReportingYears>>,
): Promise<{ assigned: ReportDocument[]; relevant: ReportDocument[] }> {
  const { data, error } = await client.rpc("vat_report_documents", {
    target_company_id: companyId,
    target_period: period,
  });
  if (error) throw error;
  const assigned = data as unknown as ReportDocument[];
  const assignedIds = new Set(assigned.map((document) => document.id));
  const overviews = await listCompanyDocuments(client, companyId);
  // A Document without a Reporting Period still blocks the readiness of the
  // period of its Import Date, so unfinished work is not overlooked. It does
  // not join that period's VAT Report.
  const candidateIds = overviews
    .filter((document) =>
      !assignedIds.has(document.id) &&
      document.reportingPeriod === null &&
      document.importDate !== null &&
      reportingPeriodForDate(document.importDate, reportingYears) === period,
    )
    .map((document) => document.id);
  const candidates: ReportDocument[] = [];
  for (let offset = 0; offset < candidateIds.length; offset += 100) {
    const { data: rows, error: rowsError } = await client
      .from("vat_report_document")
      .select("id, status, extraction_version_id, payload, claimed_reporting_period")
      .eq("company_id", companyId)
      .in("id", candidateIds.slice(offset, offset + 100));
    if (rowsError) throw rowsError;
    candidates.push(...rows.map((row) => ({
      id: row.id,
      status: row.status,
      extractionVersionId: row.extraction_version_id,
      payload: row.payload as unknown as ReportDocument["payload"],
      claimedReportingPeriod: row.claimed_reporting_period,
    })));
  }
  return {
    assigned,
    relevant: [...assigned, ...candidates].toSorted((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Reads live readiness and saved-snapshot freshness without writing Documents or VAT Reports. */
export async function getReportingPeriodReadiness(
  client: AppClient,
  input: { companyId: string; period: string },
): Promise<Result<ReportingPeriodReadiness, ReportingPeriodReadinessError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  if (!isReportingPeriod(input.period)) {
    return { ok: false, error: "invalid_reporting_period" };
  }
  const company = await getCompany(client, input.companyId);
  if (!company) return { ok: false, error: "forbidden" };
  const [frequency, reportingYears] = await Promise.all([
    getReportingPeriodFrequency(client, input.companyId, input.period),
    listCompanyReportingYears(client, input.companyId),
  ]);
  if (
    frequency === null ||
    (input.period.includes("-Q") ? frequency !== "quarterly" : frequency !== "monthly")
  ) {
    return { ok: false, error: "invalid_reporting_period" };
  }
  const [{ assigned, relevant }, report] = await Promise.all([
    relevantDocuments(client, input.companyId, input.period, reportingYears),
    getSavedSourceSnapshot(client, input.companyId, input.period),
  ]);
  const byVersion = await findingsByVersion(client, relevant);
  const source = readinessSource(relevant);
  const assignedIds = new Set(assigned.map((document) => document.id));
  const documents: LiveDocument[] = relevant.map((document) => {
    // A Document without a Reporting Period is blocked until its year exists.
    const gap = assignedIds.has(document.id)
      ? null
      : reportingPeriodGapFinding(document.payload?.taxPointDate, reportingYears);
    return {
      ...document,
      findings: [
        ...(document.extractionVersionId ? byVersion.get(document.extractionVersionId) ?? [] : []),
        ...(gap ? [gap] : []),
      ],
    };
  });
  const groups: ReportingPeriodReadiness["groups"] = {
    processing: [],
    failed: [],
    needsReview: [],
    rejected: [],
    approved: [],
  };
  const blockers: ReadinessFinding[] = [];
  const warnings: ReadinessFinding[] = [];
  for (const document of documents) {
    if (
      document.status === "uploaded"
      || document.status === "waiting_for_allowance"
      || document.status === "waiting_for_platform"
      || document.status === "processing"
    ) {
      groups.processing.push(document.id);
      blockers.push({ code: "processing", documentId: document.id });
      continue;
    }
    if (document.status === "failed") {
      groups.failed.push(document.id);
      blockers.push({ code: "failed", documentId: document.id });
      continue;
    }
    if (document.status === "rejected") {
      groups.rejected.push(document.id);
      continue;
    }
    if (document.status === "needs_review") {
      groups.needsReview.push(document.id);
      blockers.push({ code: "needs_review", documentId: document.id });
    } else {
      groups.approved.push(document.id);
    }
    if (!document.payload?.direction) {
      blockers.push({ code: "missing_direction", documentId: document.id });
    }
    if (!document.payload?.taxPointDate) {
      blockers.push({ code: "missing_tax_point_date", documentId: document.id });
    }
    if (!document.payload?.rateBreakdown.length) {
      blockers.push({ code: "missing_rate", documentId: document.id });
    }
    if (!document.payload?.currency) {
      blockers.push({ code: "missing_currency", documentId: document.id });
    }
    for (const finding of document.findings) {
      const target = finding.severity === "error" ? blockers : warnings;
      target.push({
        code: finding.severity === "error" ? "error_finding" : "warning_finding",
        documentId: document.id,
        findingCode: finding.code,
      });
    }
  }
  return {
    ok: true,
    value: {
      companyId: input.companyId,
      period: input.period,
      ready: blockers.length === 0,
      blockers,
      warnings,
      groups,
      source,
      snapshot: report
        ? {
            reportId: report.id,
            generatedAt: report.generatedAt,
            freshness: snapshotIsCurrent(report, assigned, relevant, source) ? "current" : "stale",
          }
        : null,
    },
  };
}
