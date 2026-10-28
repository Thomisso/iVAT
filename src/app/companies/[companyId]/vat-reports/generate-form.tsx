"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { generateVatReportAction } from "@/app/actions";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

export function GenerateForm({
  companyId,
  period,
  exists,
}: {
  companyId: string;
  period: string;
  exists: boolean;
}) {
  const t = useTranslations("vatReports");
  const [state, action, pending] = useActionState(generateVatReportAction, {
    error: null,
    values: {},
  });
  return (
    <form action={action} className="form filters">
      <input type="hidden" name="companyId" value={companyId} />
      <TextField
        label={t("period")}
        type="text"
        name="period"
        required
        pattern="20[0-9]{2}-(0[1-9]|1[0-2]|Q[1-4])"
        placeholder={t("periodPlaceholder")}
        hint={t("periodHint")}
        defaultValue={state.values.period ?? period}
      />
      <Button type="submit" disabled={pending}>
        {t(exists ? "regenerate" : "generate")}
      </Button>
      <FormError error={state.error} />
    </form>
  );
}
