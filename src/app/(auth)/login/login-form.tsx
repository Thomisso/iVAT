"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { logInAction } from "@/app/actions";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { FormError } from "@/components/form-error";

export function LogInForm() {
  const t = useTranslations("auth");
  const [state, action, pending] = useActionState(logInAction, {
    error: null,
    values: {},
  });
  return (
    <form action={action} className="form">
      <TextField
        label={t("email")}
        type="email"
        name="email"
        defaultValue={state.values.email}
        autoComplete="email"
        required
      />
      <TextField
        label={t("password")}
        type="password"
        name="password"
        autoComplete="current-password"
        required
      />
      <FormError error={state.error} />
      <Button variant="primary" type="submit" disabled={pending}>
        {t("logIn")}
      </Button>
    </form>
  );
}
