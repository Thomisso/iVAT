"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { setCompanyAutomaticApprovalAction } from "./automatic-approval-actions";

export function AutomaticApprovalForm({ companyId, enabled }: { companyId: string; enabled: boolean }) {
  const t = useTranslations("automaticApproval");
  const [state, action, pending] = useActionState(setCompanyAutomaticApprovalAction, {
    error: null,
    values: { automaticApprovalEnabled: enabled ? "on" : "" },
  });
  return <form action={action} className="form settings-form" key={JSON.stringify(state.values)}>
    <input name="companyId" type="hidden" value={companyId} />
    <label className="iv-checkbox-row">
      <input name="automaticApprovalEnabled" type="checkbox" defaultChecked={state.values.automaticApprovalEnabled === "on"}
        aria-describedby="automatic-approval-hint" disabled={pending} />
      <span>{t("enabled")}</span>
    </label>
    <p className="iv-field-hint" id="automatic-approval-hint">{t("hint")}</p>
    <FormError error={state.error} />
    {state.values.saved === "yes" && <p role="status">{t("saved")}</p>}
    <Button type="submit" disabled={pending}>{t(pending ? "saving" : "save")}</Button>
  </form>;
}
