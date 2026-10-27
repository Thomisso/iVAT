"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { acceptInvitationAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

export function AcceptInvitationForm({ token }: { token: string }) {
  const t = useTranslations("members");
  const [state, action, pending] = useActionState(acceptInvitationAction, { error: null, values: {} });
  return (
    <form action={action} className="form">
      <input type="hidden" name="token" value={token} />
      <FormError error={state.error} />
      <Button type="submit" variant="primary" disabled={pending}>{t("accept")}</Button>
    </form>
  );
}
