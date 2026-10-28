"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { setOrganizationMfaRequiredAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

export function OrganizationMfaForm({ organizationId, required }: { organizationId: string; required: boolean }) {
  const t = useTranslations("mfa");
  const [state, action, pending] = useActionState(setOrganizationMfaRequiredAction, { error: null, values: {} });
  return (
    <form action={action}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="required" value={String(!required)} />
      <Button type="submit" variant={required ? "ghost" : "primary"} disabled={pending}>
        {required ? t("stopRequiring") : t("requireForOrganization")}
      </Button>
      <FormError error={state.error} />
    </form>
  );
}
