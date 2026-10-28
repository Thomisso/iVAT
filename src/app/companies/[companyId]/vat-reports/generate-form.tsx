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
  locked,
}: {
  companyId: string;
  period: string;
  exists: boolean;
  locked: boolean;
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
        type="month"
        name="period"
        required
        min="2000-01"
        max="2099-12"
        defaultValue={state.values.period ?? period}
      />
      <Button type="submit" disabled={pending || locked}>
        {t(exists ? "regenerate" : "generate")}
      </Button>
      <FormError error={state.error} />
    </form>
  );
}
