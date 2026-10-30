"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { setCurrentReportingYearAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

export function FilingFrequencyForm({ companyId, year, initialValues }: {
  companyId: string;
  year: number;
  initialValues: Record<string, string>;
}) {
  const t = useTranslations("company");
  const [state, action, pending] = useActionState(setCurrentReportingYearAction, {
    error: null,
    values: initialValues,
  });
  return <form action={action} className="form" key={JSON.stringify(state.values)}>
    <input name="companyId" type="hidden" value={companyId} />
    <p className="iv-field-hint">{t("currentReportingYear", { year })}</p>
    <label className="iv-field-label">
      {t("filingFrequency")}
      <select name="filingFrequency" defaultValue={state.values.filingFrequency ?? "monthly"} required>
        <option value="monthly">{t("monthly")}</option>
        <option value="quarterly">{t("quarterly")}</option>
      </select>
    </label>
    <p className="iv-field-hint">{t("currentReportingYearHint")}</p>
    <FormError error={state.error} />
    <Button variant="primary" type="submit" disabled={pending}>{t("completeSetup")}</Button>
  </form>;
}
