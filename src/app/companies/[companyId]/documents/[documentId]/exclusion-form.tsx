"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { rejectDocumentAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

/** Exclusion resolves unfinished work only after a deliberate, recorded reason. */
export function ExclusionForm({ fields }: { fields: Record<string, string> }) {
  const t = useTranslations("review");
  const [state, action, pending] = useActionState(rejectDocumentAction, { error: null, values: {} });
  return <form action={action} className="form">
    {Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
    <label>
      <span>{t("exclusionReason")}</span>
      <textarea className="iv-input" name="reason" required maxLength={500} defaultValue={state.values.reason ?? ""} />
    </label>
    <FormError error={state.error} />
    <Button type="submit" variant="danger" disabled={pending}>{t("reject")}</Button>
  </form>;
}
