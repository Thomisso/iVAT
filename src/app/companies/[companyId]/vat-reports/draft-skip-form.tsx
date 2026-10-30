"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { skipVatReportDraftsAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

export function DraftSkipForm({ companyId, period, reportGeneratedAt, downloadedCount }: {
  companyId: string; period: string; reportGeneratedAt: string; downloadedCount: number;
}) {
  const t = useTranslations("vatReports.wizard");
  const [state, action, pending] = useActionState(skipVatReportDraftsAction, { error: null, values: {} });
  return <form action={action} className="form">
    <input type="hidden" name="companyId" value={companyId} />
    <input type="hidden" name="period" value={period} />
    <input type="hidden" name="reportGeneratedAt" value={reportGeneratedAt} />
    <FormError error={state.error} />
    <Button type="submit" disabled={pending}>{t(downloadedCount ? "skipRemainingDraft" : "skipDrafts")}</Button>
  </form>;
}
