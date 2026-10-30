"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { acceptInvitationAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

export function AcceptInvitationForm({
  token,
  email,
  existingUser,
  alreadyAuthenticated = false,
}: {
  token: string;
  email: string;
  existingUser: boolean;
  alreadyAuthenticated?: boolean;
}) {
  const t = useTranslations("members");
  const auth = useTranslations("auth");
  const [state, action, pending] = useActionState(acceptInvitationAction, { error: null, values: {} });
  return (
    <form action={action} className="form">
      <input type="hidden" name="token" value={token} />
      <TextField label={auth("email")} type="email" value={email} readOnly />
      {!alreadyAuthenticated && <TextField
        label={existingUser ? auth("password") : t("newPassword")}
        type="password"
        name="password"
        autoComplete={existingUser ? "current-password" : "new-password"}
        minLength={existingUser ? undefined : 8}
        required
      />}
      <FormError error={state.error} />
      <Button type="submit" variant="primary" disabled={pending}>{t("accept")}</Button>
    </form>
  );
}
