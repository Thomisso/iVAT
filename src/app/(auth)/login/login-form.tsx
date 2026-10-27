"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { logInAction } from "@/app/actions";
import { FormError } from "@/components/form-error";

export function LogInForm() {
  const t = useTranslations("auth");
  const [state, action, pending] = useActionState(logInAction, { error: null, values: {} });
  return (
    <form action={action} className="form">
      <label>
        {t("email")}
        <input type="email" name="email" defaultValue={state.values.email} autoComplete="email" required />
      </label>
      <label>
        {t("password")}
        <input type="password" name="password" autoComplete="current-password" required />
      </label>
      <FormError error={state.error} />
      <button type="submit" disabled={pending}>
        {t("logIn")}
      </button>
    </form>
  );
}
