"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  finalizeVatReportAction,
  unlockReportingPeriodAction,
} from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

export function PeriodLockForm({
  companyId,
  period,
  locked,
}: {
  companyId: string;
  period: string;
  locked: boolean;
}) {
  const t = useTranslations("vatReports");
  const [state, action, pending] = useActionState(
    locked ? unlockReportingPeriodAction : finalizeVatReportAction,
    { error: null, values: {} },
  );
  return (
    <form action={action} className="form filters">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="period" value={period} />
      <Button type="submit" variant={locked ? "secondary" : "primary"} disabled={pending}>
        {t(locked ? "unlock" : "finalize")}
      </Button>
      <FormError error={state.error} />
    </form>
  );
}
