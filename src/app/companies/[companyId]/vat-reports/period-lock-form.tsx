"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  finalizeVatReportAction,
  unlockReportingPeriodAction,
} from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { Notice } from "@/components/notice";

type FinalizationSummary = {
  blockerCount: number;
  warningCount: number;
  rejectedDocumentCount: number;
  snapshotCurrent: boolean;
  identityComplete: boolean;
};

export function PeriodLockForm({
  companyId,
  period,
  locked,
  summary,
}: {
  companyId: string;
  period: string;
  locked: boolean;
  summary: FinalizationSummary;
}) {
  const t = useTranslations("vatReports");
  const [state, action, pending] = useActionState(
    locked ? unlockReportingPeriodAction : finalizeVatReportAction,
    { error: null, values: {} },
  );
  const finalizable = summary.snapshotCurrent &&
    summary.identityComplete &&
    summary.blockerCount === 0;
  return (
    <form action={action} className="form period-lock-form">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="period" value={period} />
      {locked ? (
        <>
          <Notice tone="warning" title={t("unlockConfirmationTitle")}>
            {t("unlockImpact")}
          </Notice>
          <label className="iv-field-label" htmlFor="unlock-reason">
            {t("unlockReason")}
          </label>
          <textarea
            className="iv-input"
            id="unlock-reason"
            name="reason"
            minLength={3}
            maxLength={200}
            required
            defaultValue={state.values.reason ?? ""}
          />
          <label className="period-lock-confirmation">
            <input
              type="checkbox"
              name="confirmed"
              required
              defaultChecked={state.values.confirmed === "on"}
            />
            <span>{t("unlockConfirmation")}</span>
          </label>
          <Button type="submit" variant="secondary" disabled={pending}>
            {t("unlock")}
          </Button>
        </>
      ) : (
        <>
          <Notice tone={finalizable ? "info" : "warning"} title={t("finalizationConfirmationTitle")}>
            {t("finalizationImpact")}
          </Notice>
          <dl className="finalization-summary">
            <div>
              <dt>{t("finalizationSnapshot")}</dt>
              <dd>{t(summary.snapshotCurrent ? "freshnessState.current" : "freshnessState.stale")}</dd>
            </div>
            <div>
              <dt>{t("finalizationBlockers")}</dt>
              <dd>{summary.blockerCount}</dd>
            </div>
            <div>
              <dt>{t("finalizationWarnings")}</dt>
              <dd>{summary.warningCount}</dd>
            </div>
            <div>
              <dt>{t("finalizationRejected")}</dt>
              <dd>{summary.rejectedDocumentCount}</dd>
            </div>
          </dl>
          <label className="period-lock-confirmation">
            <input
              type="checkbox"
              name="confirmed"
              required
              disabled={!finalizable}
              defaultChecked={state.values.confirmed === "on"}
            />
            <span>{t("finalizationConfirmation")}</span>
          </label>
          <Button type="submit" variant="primary" disabled={pending || !finalizable}>
            {t("finalize")}
          </Button>
        </>
      )}
      <FormError error={state.error} />
    </form>
  );
}
