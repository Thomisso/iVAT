"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { updateDocumentReportingAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

/** The optional Deferred Claim of an incoming Document. */
export function ReportingAssignmentForm({
  companyId,
  documentId,
  claimedReportingPeriod,
  periods,
}: {
  companyId: string;
  documentId: string;
  claimedReportingPeriod: string | null;
  periods: readonly string[];
}) {
  const t = useTranslations("review.reportingAssignment");
  const [state, action, pending] = useActionState(
    updateDocumentReportingAction,
    { error: null, values: {} },
  );

  return (
    <form action={action} className="form">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="documentId" value={documentId} />
      <fieldset>
        <legend>{t("title")}</legend>
        <div className="fields">
          <label>
            <span>{t("claimedReportingPeriod")}</span>
            <select className="iv-input" name="claimedReportingPeriod" defaultValue={state.values.claimedReportingPeriod ?? claimedReportingPeriod ?? ""}>
              <option value="">{t("defaultPeriod")}</option>
              {claimedReportingPeriod && !periods.includes(claimedReportingPeriod) && <option value={claimedReportingPeriod} disabled>{claimedReportingPeriod}</option>}
              {periods.map((period) => <option key={period} value={period}>{period}</option>)}
            </select>
            <small>{t("claimedReportingPeriodHint")}</small>
          </label>
        </div>
      </fieldset>
      <FormError error={state.error} />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? t("saving") : t("save")}
      </Button>
    </form>
  );
}
