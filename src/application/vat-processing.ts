import type { AppClient, Result } from "./client";
import { getCompanySetupChecklist, getMyCompanyRole } from "./companies";
import { listCompanyDocuments, type DocumentOverview } from "./documents";
import { listVatReportArtifacts } from "./epo-export";
import {
  getReportingPeriodReadiness,
  readinessDocumentIds,
  type ReportingPeriodReadiness,
  type ReportingPeriodReadinessError,
} from "./reporting-period-readiness";
import { getPeriodLock } from "./vat-reports";

export const VAT_PROCESSING_STEPS = [
  "review",
  "generate",
  "outputs",
  "export",
  "finalize",
] as const;
export type VatProcessingStepKey = (typeof VAT_PROCESSING_STEPS)[number];
export type VatProcessingStepState = "done" | "needs_attention" | "blocked" | "not_started";
export type VatProcessingStepReason =
  | "documents_need_review"
  | "report_missing"
  | "report_stale"
  | "warnings"
  | "identity_incomplete"
  | "administrator_only";

export type VatProcessingStep = {
  key: VatProcessingStepKey;
  state: VatProcessingStepState;
  reason: VatProcessingStepReason | null;
  /** The earlier step that makes this one unavailable. */
  blockedBy: VatProcessingStepKey | null;
};

export type VatProcessingWizard = {
  readiness: ReportingPeriodReadiness;
  steps: VatProcessingStep[];
  /** Documents that block the period, at most `DOCUMENTS_TO_REVIEW_LIMIT`. */
  documentsToReview: DocumentOverview[];
  documentsToReviewCount: number;
  locked: boolean;
};

export const DOCUMENTS_TO_REVIEW_LIMIT = 20;

function step(
  key: VatProcessingStepKey,
  state: VatProcessingStepState,
  reason: VatProcessingStepReason | null = null,
  blockedBy: VatProcessingStepKey | null = null,
): VatProcessingStep {
  return { key, state, reason, blockedBy };
}

/** The five ordered VAT processing steps of one Reporting Period, derived from its readiness. */
export async function getVatProcessingWizard(
  client: AppClient,
  input: { companyId: string; period: string },
): Promise<Result<VatProcessingWizard, ReportingPeriodReadinessError>> {
  const readinessResult = await getReportingPeriodReadiness(client, input);
  if (!readinessResult.ok) return readinessResult;
  const readiness = readinessResult.value;
  const blockerIds = readinessDocumentIds(readiness, "blockers");
  const [lock, artifacts, role, setup, documentsToReview] = await Promise.all([
    getPeriodLock(client, input.companyId, input.period),
    listVatReportArtifacts(client, input),
    getMyCompanyRole(client, input.companyId),
    getCompanySetupChecklist(client, input.companyId),
    listCompanyDocuments(client, input.companyId, {
      documentIds: blockerIds.slice(0, DOCUMENTS_TO_REVIEW_LIMIT),
    }),
  ]);
  const exported = readiness.snapshot !== null && artifacts.some((artifact) =>
    artifact.vatReportId === readiness.snapshot?.reportId &&
    artifact.reportGeneratedAt === readiness.snapshot.generatedAt
  );
  const exportStep = step("export", exported ? "done" : "not_started");

  let steps: VatProcessingStep[];
  if (lock) {
    steps = [
      step("review", "done"),
      step("generate", "done"),
      step("outputs", "done"),
      exportStep,
      step("finalize", "done"),
    ];
  } else {
    const review = blockerIds.length > 0
      ? step("review", "needs_attention", "documents_need_review")
      : step("review", "done");
    const generate = review.state !== "done"
      ? step("generate", "blocked", review.reason, "review")
      : readiness.snapshot === null
        ? step("generate", "not_started", "report_missing")
        : readiness.snapshot.freshness === "stale"
          ? step("generate", "needs_attention", "report_stale")
          : step("generate", "done");
    const gate = [review, generate].find((earlier) => earlier.state !== "done");
    const blocked = (key: VatProcessingStepKey) =>
      step(key, "blocked", gate!.reason, gate!.key);
    const identityComplete = setup.some((item) =>
      item.step === "identity" && item.state === "completed"
    );
    steps = [
      review,
      generate,
      gate
        ? blocked("outputs")
        : readiness.warnings.length > 0
          ? step("outputs", "needs_attention", "warnings")
          : step("outputs", "done"),
      gate ? blocked("export") : exportStep,
      gate
        ? blocked("finalize")
        : !identityComplete
          ? step("finalize", "blocked", "identity_incomplete")
          : role !== "administrator"
            ? step("finalize", "blocked", "administrator_only")
            : step("finalize", "not_started"),
    ];
  }
  return {
    ok: true,
    value: {
      readiness,
      steps,
      documentsToReview,
      documentsToReviewCount: blockerIds.length,
      locked: lock !== null,
    },
  };
}
