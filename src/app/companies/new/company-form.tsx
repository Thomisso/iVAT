"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { createCompanyAction } from "@/app/actions";
import { FormError } from "@/components/form-error";

export function CompanyForm({ organizationId }: { organizationId: string }) {
  const t = useTranslations("company");
  const [state, action, pending] = useActionState(createCompanyAction, { error: null, values: {} });
  return (
    <form action={action} className="form">
      <input type="hidden" name="organizationId" value={organizationId} />
      <label>
        {t("name")}
        <input name="name" defaultValue={state.values.name} required />
      </label>
      <label>
        {t("ico")}
        <input name="ico" defaultValue={state.values.ico} inputMode="numeric" required />
      </label>
      <label>
        {t("vatId")}
        <input name="vatId" defaultValue={state.values.vatId} placeholder="CZ12345678" required />
      </label>
      <label>
        {t("street")}
        <input name="street" defaultValue={state.values.street} autoComplete="street-address" required />
      </label>
      <div className="form-row">
        <label>
          {t("city")}
          <input name="city" defaultValue={state.values.city} autoComplete="address-level2" required />
        </label>
        <label>
          {t("postalCode")}
          <input name="postalCode" defaultValue={state.values.postalCode} autoComplete="postal-code" inputMode="numeric" required />
        </label>
      </div>
      <FormError error={state.error} />
      <button type="submit" disabled={pending}>
        {t("create")}
      </button>
    </form>
  );
}
