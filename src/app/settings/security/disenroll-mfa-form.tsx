"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { disenrollMfaAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

export function DisenrollMfaForm() {
  const t = useTranslations("mfa");
  const [state, action, pending] = useActionState(disenrollMfaAction, { error: null, values: {} });
  return <form action={action} className="form">
    <FormError error={state.error} />
    <Button type="submit" variant="ghost" disabled={pending}>{t("disableAuthenticator")}</Button>
  </form>;
}
