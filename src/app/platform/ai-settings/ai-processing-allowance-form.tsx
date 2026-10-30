"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { setCompanyAiProcessingAllowanceAction, type FormState } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

export function AiProcessingAllowanceForm({
  companyId,
  allowance,
}: {
  companyId: string;
  allowance: number | null;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(setCompanyAiProcessingAllowanceAction, {
    error: null,
    values: {},
  });
  const t = useTranslations("platformAi");
  const unlimited = state.values.unlimited === "on" || (state.values.unlimited === undefined && allowance === null);

  return (
    <form action={action} className="ai-configuration-assignment-actions">
      <input type="hidden" name="companyId" value={companyId} />
      <label className="iv-field-label">
        {t("allowance")}
        <input
          className="iv-input"
          type="number"
          name="allowance"
          min="0"
          step="1"
          defaultValue={state.values.allowance ?? allowance ?? 50}
          required
        />
      </label>
      <label className="iv-checkbox">
        <input type="checkbox" name="unlimited" defaultChecked={unlimited} />
        <span>{t("unlimitedAllowance")}</span>
      </label>
      <Button type="submit" size="sm" disabled={pending}>{t("saveAllowance")}</Button>
      <FormError error={state.error} />
    </form>
  );
}
