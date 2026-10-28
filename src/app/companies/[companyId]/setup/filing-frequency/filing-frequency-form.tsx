"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { setCompanyFilingFrequencyAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

export function FilingFrequencyForm({ companyId, initialValues }: {
  companyId: string;
  initialValues: Record<string, string>;
}) {
  const t = useTranslations("company");
  const [state, action, pending] = useActionState(setCompanyFilingFrequencyAction, {
    error: null,
    values: initialValues,
  });
  return <form action={action} className="form" key={JSON.stringify(state.values)}>
    <input name="companyId" type="hidden" value={companyId} />
    <label className="iv-field-label">
      {t("filingFrequency")}
      <select name="filingFrequency" defaultValue={state.values.filingFrequency ?? "monthly"} required>
        <option value="monthly">{t("monthly")}</option>
        <option value="quarterly">{t("quarterly")}</option>
      </select>
    </label>
    <TextField
      type="date"
      label={t("effectiveFrom")}
      name="filingFrequencyEffectiveFrom"
      defaultValue={state.values.filingFrequencyEffectiveFrom}
      required
    />
    <p className="iv-field-hint">{t("effectiveFromHint")}</p>
    <FormError error={state.error} />
    <Button variant="primary" type="submit" disabled={pending}>{t("completeSetup")}</Button>
  </form>;
}
