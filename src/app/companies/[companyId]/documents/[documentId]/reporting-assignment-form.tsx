"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { updateDocumentReportingAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

/** Receipt Date and an optional later input-VAT claim for an incoming Document. */
export function ReportingAssignmentForm({
  companyId,
  documentId,
  receiptDate,
  claimedReportingPeriod,
}: {
  companyId: string;
  documentId: string;
  receiptDate: string;
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
            label={t("receiptDate")}
            name="receiptDate"
            type="date"
            required
            defaultValue={state.values.receiptDate ?? receiptDate}
          />
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
