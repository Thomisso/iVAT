"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { requestPasswordRecoveryAction } from "@/app/password-recovery-actions";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { FormError } from "@/components/form-error";

export function RecoveryRequestForm() {
  const t = useTranslations("passwordRecovery");
  const auth = useTranslations("auth");
  const [state, action, pending] = useActionState(requestPasswordRecoveryAction, { error: null, values: {} });
  if (state.complete) return <p role="status">{t("requestSent")}</p>;
  return <form action={action} className="form">
    <TextField label={auth("email")} type="email" name="email" autoComplete="email" defaultValue={state.values.email} required />
    <FormError error={state.error} />
    <Button type="submit" variant="primary" disabled={pending}>{t("request")}</Button>
  </form>;
}
