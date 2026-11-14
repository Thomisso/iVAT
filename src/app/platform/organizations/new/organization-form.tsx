"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";
import { createOrganizationAction } from "./actions";

export function OrganizationForm() {
  const t = useTranslations("organizationCreation");
  const [state, action, pending] = useActionState(createOrganizationAction, { error: null, values: { name: "" } });
  return <form action={action} className="form" key={JSON.stringify(state.values)}>
    <TextField label={t("name")} name="name" defaultValue={state.values.name} required />
    <FormError error={state.error} />
    <Button type="submit" variant="primary" disabled={pending}>{t("create")}</Button>
    <Link href="/platform/administration">{t("cancel")}</Link>
  </form>;
}
