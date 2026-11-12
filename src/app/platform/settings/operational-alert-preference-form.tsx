"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import type { FormState } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { setOperationalAlertPreferenceAction } from "./actions";

export function OperationalAlertPreferenceForm({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(setOperationalAlertPreferenceAction, { error: null, values: {} });
  const t = useTranslations("operationalAlerts");
  const checked = state.values.enabled === undefined ? enabled : state.values.enabled === "on";
  return <form action={action}>
    <label className="iv-checkbox">
      <input type="checkbox" name="enabled" defaultChecked={checked} />
      <span>{t("enabled")}</span>
    </label>
    <Button type="submit" disabled={pending}>{t("save")}</Button>
    <FormError error={state.error} />
  </form>;
}
