"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { updateDocumentReportingAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

/** The optional Deferred Claim of an incoming Document. */
export function ReportingAssignmentForm({
  companyId,
  documentId,
  claimedReportingPeriod,
}: {
  companyId: string;
  documentId: string;
  claimedReportingPeriod: string | null;
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
          <TextField
            label={t("claimedReportingPeriod")}
            hint={t("claimedReportingPeriodHint")}
            name="claimedReportingPeriod"
            placeholder={t("claimedReportingPeriodPlaceholder")}
            defaultValue={
              state.values.claimedReportingPeriod ??
              claimedReportingPeriod ??
              ""
            }
          />
        </div>
      </fieldset>
      <FormError error={state.error} />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? t("saving") : t("save")}
      </Button>
    </form>
  );
}
