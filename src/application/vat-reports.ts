import { isUuid, type AppClient, type Result } from "./client";
import {
  getCompany,
  getCompanySetupChecklist,
  getReportingPeriodFrequency,
  listCompanyReportingYears,
  type CompanyDetails,
} from "./companies";
import {
  computeVatReport,
  isReportingPeriod,
  type ComputedVatReport,
  type ReportDocument,
} from "./vat-rules";
import type { Json } from "@/lib/database.types";
import {
  getReportingPeriodReadiness,
  type ReportingPeriodReadinessSource,
  type SourceFileReadiness,
} from "./reporting-period-readiness";

export type VatReport = {
  id: string;
  companyId: string;
  period: string;
  generatedAt: string;
  result: ComputedVatReport & {
    readinessSource?: ReportingPeriodReadinessSource[];
    sourceFilesReadinessSource?: SourceFileReadiness[];
  };
  documents: ReportDocument[];
  finalization: {
    blockerCount: number;
    warningCount: number;
    rejectedDocumentCount: number;
  };
};
export type GenerateVatReportError =
  "forbidden" | "company_setup_incomplete" | "invalid_reporting_period" | "stale_report" | "period_locked" | "claim_eligibility_unresolved";

export type PeriodLock = {
  id: string;
  companyId: string;
  period: string;
  vatReportId: string;
  lockedBy: string;
  lockedAt: string;
};

export type FinalizeVatReportError =
  | "forbidden"
  | "invalid_reporting_period"
  | "report_not_found"
  | "confirmation_required"
  | "company_setup_incomplete"
  | "stale_report"
  | "readiness_blocked";
export type UnlockReportingPeriodError =
  | "forbidden"
  | "invalid_reporting_period"
  | "not_locked"
  | "confirmation_required"
  | "unlock_reason_required"
  | "unlock_reason_too_long";

export type VatReportTransition = {
  periodLockId: string | null;
  id: number;
  action: "vat_report.finalized" | "reporting_period.unlocked";
  actorUserId: string;
  actorEmail: string | null;
  occurredAt: string;
  vatReportId: string;
  unlockReason: string | null;
};

function periodTransitionRefusal<E extends string>(
  error: { code?: string; hint?: string },
  codes: E[],
): Result<never, E | "forbidden"> {
  if (error.code === "42501") return { ok: false, error: "forbidden" };
  const code = codes.find((candidate) => candidate === error.hint);
  if (code) return { ok: false, error: code };
  throw error;
}

/** Finalizes the stored VAT Report and locks its Reporting Period (ADR-0007). */
export async function finalizeVatReport(
  client: AppClient,
  input: { companyId: string; period: string; confirmed: boolean },
): Promise<Result<null, FinalizeVatReportError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  if (!isReportingPeriod(input.period))
    return { ok: false, error: "invalid_reporting_period" };
  const { error } = await client.rpc("finalize_vat_report", {
    target_company_id: input.companyId,
    target_period: input.period,
    finalization_confirmed: input.confirmed,
  });
  if (error) {
    return periodTransitionRefusal(error, [
      "report_not_found",
      "confirmation_required",
      "company_setup_incomplete",
      "stale_report",
      "readiness_blocked",
    ]);
  }
  return { ok: true, value: null };
}

/** Removes a Period Lock so the Company's Documents can be corrected again. */
export async function unlockReportingPeriod(
  client: AppClient,
  input: { companyId: string; period: string; reason: string; confirmed: boolean },
): Promise<Result<null, UnlockReportingPeriodError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  if (!isReportingPeriod(input.period))
    return { ok: false, error: "invalid_reporting_period" };
  const { error } = await client.rpc("unlock_reporting_period", {
    target_company_id: input.companyId,
    target_period: input.period,
    unlock_reason: input.reason,
    unlock_confirmed: input.confirmed,
  });
  if (error) {
    return periodTransitionRefusal(error, [
      "not_locked",
      "confirmation_required",
      "unlock_reason_required",
      "unlock_reason_too_long",
    ]);
  }
  return { ok: true, value: null };
}

/** Every Finalization and unlock for a Reporting Period, oldest first. */
export async function listVatReportTransitions(
  client: AppClient,
  companyId: string,
  period: string,
): Promise<VatReportTransition[]> {
  if (!isUuid(companyId) || !isReportingPeriod(period)) return [];
  const { data, error } = await client.rpc("vat_report_transition_history", {
    target_company_id: companyId,
    target_period: period,
  });
  if (error?.code === "42501") return [];
  if (error) throw error;
  return data.map((transition) => ({
    id: transition.id,
    periodLockId: transition.period_lock_id,
    action: transition.action as VatReportTransition["action"],
    actorUserId: transition.actor_user_id,
    actorEmail: transition.actor_email,
    occurredAt: transition.occurred_at,
    vatReportId: transition.vat_report_id,
    unlockReason: transition.unlock_reason,
  }));
}

/** The active lock for a Reporting Period, visible to Company members. */
export async function getPeriodLock(
  client: AppClient,
  companyId: string,
  period: string,
): Promise<PeriodLock | null> {
  if (!isUuid(companyId) || !isReportingPeriod(period)) return null;
  const { data, error } = await client
    .from("period_lock")
    .select("id, company_id, period, vat_report_id, locked_by, locked_at")
    .eq("company_id", companyId)
    .eq("period", period)
    .maybeSingle();
  if (error) throw error;
  return data
    ? {
        id: data.id,
        companyId: data.company_id,
        period: data.period,
        vatReportId: data.vat_report_id,
        lockedBy: data.locked_by,
        lockedAt: data.locked_at,
      }
    : null;
}

/** Generates or replaces a draft for a valid monthly or quarterly Reporting Period. */
export async function generateVatReport(
  client: AppClient,
  input: { companyId: string; period: string },
): Promise<Result<{ id: string }, GenerateVatReportError>> {
  if (!isReportingPeriod(input.period))
    return { ok: false, error: "invalid_reporting_period" };
  const company = await getCompany(client, input.companyId);
  if (!company) return { ok: false, error: "forbidden" };
  const setup = await getCompanySetupChecklist(client, company.id);
  if (setup.some((item) => (item.step === "identity" || item.step === "filing_frequency") && item.state !== "completed")) {
    return { ok: false, error: "company_setup_incomplete" };
  }
  const frequency = await getReportingPeriodFrequency(
    client,
    company.id,
    input.period,
  );
  if (
    frequency === null ||
    (input.period.includes("-Q") ? frequency !== "quarterly" : frequency !== "monthly")
  ) {
    return { ok: false, error: "invalid_reporting_period" };
  }
  const readiness = await getReportingPeriodReadiness(client, input);
  if (!readiness.ok) return readiness;
  const eligibility = await client.rpc("reporting_period_claim_issues", { target_company_id: company.id, target_period: input.period });
  if (eligibility.error) throw eligibility.error;
  if (Array.isArray(eligibility.data) && eligibility.data.length) return { ok: false, error: "claim_eligibility_unresolved" };
  const reportingYears = await listCompanyReportingYears(client, company.id);
  const { data, error } = await client.rpc("vat_report_documents", {
    target_company_id: company.id,
    target_period: input.period,
  });
  if (error) throw error;
  const documents = data as unknown as ReportDocument[];
  const details: CompanyDetails = {
    name: company.name,
    firstName: company.firstName,
    lastName: company.lastName,
    ico: company.ico,
    vatId: company.vatId,
    streetName: company.streetName,
    houseNumber: company.houseNumber,
    orientationNumber: company.orientationNumber,
    city: company.city,
    postalCode: company.postalCode,
    personType: company.personType,
  };
  const result = {
    ...computeVatReport(
      details,
      input.period,
      documents,
      reportingYears,
    ),
    readinessSource: readiness.value.source,
    sourceFilesReadinessSource: readiness.value.sourceFiles,
  };
  const saved = await client.rpc("save_vat_report", {
    target_company_id: company.id,
    target_period: input.period,
    expected_documents: documents as unknown as Json,
    computed_result: result as unknown as Json,
  });
  if (saved.error) {
    if (saved.error.code === "P0001" && saved.error.hint === "claim_eligibility_unresolved") return { ok: false, error: "claim_eligibility_unresolved" };
    if (saved.error.code === "42501") return { ok: false, error: "forbidden" };
    if (saved.error.code === "P0001" && saved.error.hint === "stale_report")
      return { ok: false, error: "stale_report" };
    if (saved.error.code === "P0001" && saved.error.hint === "period_locked")
      return { ok: false, error: "period_locked" };
    throw saved.error;
  }
  return { ok: true, value: { id: saved.data } };
}

/** Reads the saved snapshot, without recomputing it from subsequently changed Documents. */
export async function getVatReport(
  client: AppClient,
  companyId: string,
  period: string,
): Promise<VatReport | null> {
  if (!isUuid(companyId) || !isReportingPeriod(period)) return null;
  const { data, error } = await client
    .from("vat_report")
    .select("id, company_id, period, generated_at, result, documents, blocker_count, warning_count, rejected_document_count")
    .eq("company_id", companyId)
    .eq("period", period)
    .maybeSingle();
  if (error) throw error;
  return data
    ? {
        id: data.id,
        companyId: data.company_id,
        period: data.period,
        generatedAt: data.generated_at,
        result: data.result as unknown as ComputedVatReport,
        documents: data.documents as unknown as ReportDocument[],
        finalization: {
          blockerCount: data.blocker_count,
          warningCount: data.warning_count,
          rejectedDocumentCount: data.rejected_document_count,
        },
      }
    : null;
}
