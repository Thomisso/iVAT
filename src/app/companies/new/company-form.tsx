"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { createCompanyAction } from "@/app/actions";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { FormError } from "@/components/form-error";

export function CompanyForm({ organizationId }: { organizationId: string }) {
  const t = useTranslations("company");
  const [state, action, pending] = useActionState(createCompanyAction, {
    error: null,
    values: {},
  });
  return (
    <form action={action} className="form">
      <input type="hidden" name="organizationId" value={organizationId} />
      <TextField
        label={t("name")}
        name="name"
        defaultValue={state.values.name}
        required
      />
      <TextField
        label={t("ico")}
        mono
        name="ico"
        defaultValue={state.values.ico}
        inputMode="numeric"
        required
      />
      <TextField
        label={t("vatId")}
        mono
        name="vatId"
        defaultValue={state.values.vatId}
        placeholder="CZ12345678"
        required
      />
      <TextField
        label={t("street")}
        name="street"
        defaultValue={state.values.street}
        autoComplete="street-address"
        required
      />
      <div className="form-row">
        <TextField
          label={t("city")}
          name="city"
          defaultValue={state.values.city}
          autoComplete="address-level2"
          required
        />
        <TextField
          label={t("postalCode")}
          mono
          name="postalCode"
          defaultValue={state.values.postalCode}
          autoComplete="postal-code"
          inputMode="numeric"
          required
        />
      </div>
      <FormError error={state.error} />
      <Button variant="primary" type="submit" disabled={pending}>
        {t("create")}
      </Button>
    </form>
  );
}
