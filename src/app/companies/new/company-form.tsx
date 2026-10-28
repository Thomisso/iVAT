"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { createCompanyAction } from "@/app/actions";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { FormError } from "@/components/form-error";

export function CompanyForm({
  organizationId,
  companyId,
  initialValues,
}: {
  organizationId: string;
  companyId?: string;
  initialValues: Record<string, string>;
}) {
  const t = useTranslations("company");
  const [state, action, pending] = useActionState(createCompanyAction, {
    error: null,
    values: initialValues,
  });
  return (
    <form
      action={action}
      className="form"
      key={JSON.stringify(state.values)}
    >
      <input type="hidden" name="organizationId" value={organizationId} />
      {companyId && <input type="hidden" name="companyId" value={companyId} />}
      <div className="form-row form-row-action">
        <TextField
          label={t("ico")}
          mono
          name="ico"
          defaultValue={state.values.ico}
          inputMode="numeric"
          required
        />
        <Button
          variant="secondary"
          type="submit"
          name="intent"
          value="ares"
          formNoValidate
          disabled={pending}
        >
          {t("prefillFromAres")}
        </Button>
      </div>
      <TextField
        label={t("name")}
        name="name"
        defaultValue={state.values.name}
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
      <label className="iv-field-label">
        {t("personType")}
        <select
          name="personType"
          defaultValue={state.values.personType ?? "legal"}
          required
        >
          <option value="legal">{t("legalPerson")}</option>
          <option value="natural">{t("naturalPerson")}</option>
        </select>
      </label>
      <fieldset>
        <legend>{t("filingFrequencyTitle")}</legend>
        <div className="form-row">
          <label className="iv-field-label">
            {t("filingFrequency")}
            <select
              name="filingFrequency"
              defaultValue={state.values.filingFrequency ?? "monthly"}
              required
            >
              <option value="monthly">{t("monthly")}</option>
              <option value="quarterly">{t("quarterly")}</option>
            </select>
          </label>
          <TextField
            type="date"
            label={t("effectiveFrom")}
            name="filingFrequencyEffectiveFrom"
            defaultValue={state.values.filingFrequencyEffectiveFrom}
            required
          />
        </div>
        <p className="iv-field-hint">{t("effectiveFromHint")}</p>
      </fieldset>
      <FormError error={state.error} />
      <Button variant="primary" type="submit" disabled={pending}>
        {t(companyId ? "save" : "create")}
      </Button>
    </form>
  );
}
