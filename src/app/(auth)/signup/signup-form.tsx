"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { signUpAction } from "@/app/actions";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { FormError } from "@/components/form-error";

export function SignUpForm() {
  const t = useTranslations("auth");
  const [state, action, pending] = useActionState(signUpAction, {
    error: null,
    values: {},
  });
  return (
    <form action={action} className="form">
      <TextField
        label={t("organizationName")}
        hint={t("organizationNameHint")}
        name="organizationName"
        defaultValue={state.values.organizationName}
        autoComplete="organization"
        required
      />
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
        autoComplete="new-password"
        minLength={8}
        required
      />
      <FormError error={state.error} />
      <Button variant="primary" type="submit" disabled={pending}>
        {t("signUp")}
      </Button>
    </form>
  );
}
