"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { generateVatReportAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

export function GenerateForm({
  companyId,
  period,
  exists,
  locked,
  disabled,
}: {
  companyId: string;
  period: string;
  exists: boolean;
  locked: boolean;
  disabled: boolean;
}) {
  const t = useTranslations("vatReports");
  const [state, action, pending] = useActionState(generateVatReportAction, {
    error: null,
    values: {},
  });
  return (
    <form action={action} className="form filters">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="period" value={state.values.period ?? period} />
      <Button type="submit" disabled={pending || locked || disabled}>
        {t(exists ? "regenerate" : "generate")}
      </Button>
      <FormError error={state.error} />
    </form>
  );
}
