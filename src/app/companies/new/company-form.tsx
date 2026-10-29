"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { createCompanyAction } from "@/app/actions";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { FormError } from "@/components/form-error";

function CompanyIdentityFields({ error, values }: { error: string | null; values: Record<string, string> }) {
  const t = useTranslations("company");
  const errors = useTranslations("errors");
  const [personType, setPersonType] = useState(values.personType ?? "legal");
  const [streetName, setStreetName] = useState(values.streetName ?? "");
  const [orientationNumber, setOrientationNumber] = useState(values.orientationNumber ?? "");
  const [city, setCity] = useState(values.city ?? "");
  const fieldError = (...codes: string[]) => codes.includes(error ?? "") && error && errors.has(error)
    ? errors(error)
    : undefined;
  return <>
    {personType === "legal" ? <TextField
      label={t("name")}
      name="name"
      defaultValue={values.name}
      error={fieldError("name_required", "name_too_long")}
      maxLength={255}
      required
    /> : <div className="form-row">
      <TextField label={t("firstName")} name="firstName" defaultValue={values.firstName} error={fieldError("first_name_required", "first_name_too_long")} maxLength={30} required />
      <TextField label={t("lastName")} name="lastName" defaultValue={values.lastName} error={fieldError("last_name_required", "last_name_too_long")} maxLength={36} required />
    </div>}
    <TextField
      label={t("vatId")}
      mono
      name="vatId"
      defaultValue={values.vatId}
      error={fieldError("invalid_vat_id")}
      placeholder="CZ12345678"
      required
    />
    <div className="form-row">
      <TextField
        label={t("streetName")}
        name="streetName"
        value={streetName}
        onChange={(event) => setStreetName(event.currentTarget.value)}
        error={streetName.length > 38 ? t("epoStreetNameTooLong") : fieldError("address_required")}
        required
      />
      <TextField label={t("houseNumber")} name="houseNumber" defaultValue={values.houseNumber} error={fieldError("invalid_house_number")} inputMode="numeric" maxLength={6} required />
      <TextField
        label={t("orientationNumber")}
        name="orientationNumber"
        value={orientationNumber}
        onChange={(event) => setOrientationNumber(event.currentTarget.value)}
        error={orientationNumber.length > 4 ? t("epoOrientationNumberTooLong") : fieldError("invalid_orientation_number")}
        maxLength={4}
      />
    </div>
    <div className="form-row">
      <TextField
        label={t("city")}
        name="city"
        value={city}
        onChange={(event) => setCity(event.currentTarget.value)}
        error={city.length > 48 ? t("epoCityTooLong") : fieldError("address_required")}
        autoComplete="address-level2"
        required
      />
      <TextField
        label={t("postalCode")}
        mono
        name="postalCode"
        defaultValue={values.postalCode}
        error={fieldError("invalid_postal_code")}
        autoComplete="postal-code"
        inputMode="numeric"
        required
      />
    </div>
    <label className="iv-field-label">
      {t("personType")}
      <select
        name="personType"
        value={personType}
        onChange={(event) => setPersonType(event.currentTarget.value)}
        required
      >
        <option value="legal">{t("legalPerson")}</option>
        <option value="natural">{t("naturalPerson")}</option>
      </select>
    </label>
  </>;
}

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
          error={state.error === "invalid_ico" ? t("invalidIco") : undefined}
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
      <CompanyIdentityFields error={state.error} key={JSON.stringify(state.values)} values={state.values} />
      <FormError error={state.error} />
      <Button variant="primary" type="submit" disabled={pending}>
        {t(companyId ? "save" : "create")}
      </Button>
    </form>
  );
}
