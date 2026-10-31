"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { Notice } from "@/components/notice";
import { TextField } from "@/components/text-field";
import { changePasswordAction } from "./actions";

export function PasswordChangeForm() {
  const t = useTranslations("passwordChange");
  const [state, action, pending] = useActionState(changePasswordAction, { error: null, values: {}, succeeded: false });
  return <section className="form focused-shell-section">
    <h2>{t("title")}</h2>
    <p>{t("sessionHint")}</p>
    <form action={action} className="form">
      <TextField label={t("currentPassword")} name="currentPassword" type="password" autoComplete="current-password" required />
      <TextField label={t("newPassword")} name="newPassword" type="password" autoComplete="new-password" minLength={8} required />
      <TextField label={t("confirmation")} name="confirmation" type="password" autoComplete="new-password" minLength={8} required />
      <FormError error={state.error} />
      {state.succeeded && <Notice tone="success">{t("success")}</Notice>}
      <Button type="submit" variant="primary" disabled={pending}>{t("submit")}</Button>
    </form>
  </section>;
}
