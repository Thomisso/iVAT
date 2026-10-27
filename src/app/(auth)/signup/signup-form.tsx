"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { signUpAction } from "@/app/actions";
import { FormError } from "@/components/form-error";

export function SignUpForm() {
  const t = useTranslations("auth");
  const [state, action, pending] = useActionState(signUpAction, { error: null, values: {} });
  return (
    <form action={action} className="form">
      <label>
        {t("organizationName")}
        <input name="organizationName" defaultValue={state.values.organizationName} autoComplete="organization" required />
        <small>{t("organizationNameHint")}</small>
      </label>
      <label>
        {t("email")}
        <input type="email" name="email" defaultValue={state.values.email} autoComplete="email" required />
      </label>
      <label>
        {t("password")}
        <input type="password" name="password" autoComplete="new-password" minLength={8} required />
      </label>
      <FormError error={state.error} />
      <button type="submit" disabled={pending}>
        {t("signUp")}
      </button>
    </form>
  );
}
