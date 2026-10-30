"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { saveCompanyFilingDefaultsAction } from "@/app/actions";
import type { CompanyFilingDefaults } from "@/application/company-filing-defaults";
import type { PersonType } from "@/application/companies";
import { FilingOfficeFields } from "@/components/filing-office-fields";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

export function FilingDefaultsForm({
  companyId,
  personType,
  defaults,
  epoOverrideRequired,
}: {
  companyId: string;
  personType: PersonType;
  defaults: CompanyFilingDefaults | null;
  epoOverrideRequired: boolean;
}) {
  const t = useTranslations("filingDefaults");
  const initialValues = {
    taxOffice: defaults?.taxOffice ?? "",
    territorialOffice: defaults?.territorialOffice ?? "",
    economicActivity: defaults?.economicActivity ?? "",
    signatoryFirstName: defaults?.signatoryFirstName ?? "",
    signatoryLastName: defaults?.signatoryLastName ?? "",
    signatoryCapacity: defaults?.signatoryCapacity ?? "",
    email: defaults?.email ?? "",
    phone: defaults?.phone ?? "",
    useEpoAddressOverride: defaults?.epoAddressOverride ? "yes" : "",
    epoStreetName: defaults?.epoAddressOverride?.streetName ?? "",
    epoHouseNumber: defaults?.epoAddressOverride?.houseNumber ?? "",
    epoOrientationNumber: defaults?.epoAddressOverride?.orientationNumber ?? "",
    epoCity: defaults?.epoAddressOverride?.city ?? "",
    epoPostalCode: defaults?.epoAddressOverride?.postalCode ?? "",
    epoAddressConfirmed: defaults?.epoAddressOverride ? "yes" : "",
  };
  const [state, action, pending] = useActionState(saveCompanyFilingDefaultsAction, {
    error: null,
    values: initialValues,
  });
  const [useOverride, setUseOverride] = useState(state.values.useEpoAddressOverride === "yes");
  return <form action={action} className="form settings-form" key={JSON.stringify(state.values)}>
    <input name="companyId" type="hidden" value={companyId} />
    <FilingOfficeFields taxOffice={state.values.taxOffice} territorialOffice={state.values.territorialOffice} economicActivity={state.values.economicActivity} />
    {personType === "legal" && <fieldset>
      <legend>{t("signatory")}</legend>
      <div className="form-row">
        <TextField label={t("firstName")} name="signatoryFirstName" maxLength={20} defaultValue={state.values.signatoryFirstName} />
        <TextField label={t("lastName")} name="signatoryLastName" maxLength={36} defaultValue={state.values.signatoryLastName} />
      </div>
      <TextField label={t("capacity")} name="signatoryCapacity" maxLength={40} defaultValue={state.values.signatoryCapacity} />
    </fieldset>}
    <div className="form-row">
      <TextField label={t("email")} name="email" type="email" maxLength={255} defaultValue={state.values.email} />
      <TextField label={t("phone")} name="phone" type="tel" maxLength={14} defaultValue={state.values.phone} />
    </div>
    <p className="iv-field-hint">{t("contactsHint")}</p>
    {epoOverrideRequired && <fieldset>
      <legend>{t("epoAddress")}</legend>
      <p>{t("epoAddressReason")}</p>
      <label className="iv-checkbox-row">
        <input
          checked={useOverride}
          name="useEpoAddressOverride"
          onChange={(event) => setUseOverride(event.currentTarget.checked)}
          type="checkbox"
          value="yes"
        />
        {t("useEpoAddress")}
      </label>
      {useOverride && <>
        <div className="form-row">
          <TextField label={t("streetName")} name="epoStreetName" maxLength={38} defaultValue={state.values.epoStreetName} required />
          <TextField label={t("houseNumber")} name="epoHouseNumber" maxLength={6} defaultValue={state.values.epoHouseNumber} required />
          <TextField label={t("orientationNumber")} name="epoOrientationNumber" maxLength={4} defaultValue={state.values.epoOrientationNumber} />
        </div>
        <div className="form-row">
          <TextField label={t("city")} name="epoCity" maxLength={48} defaultValue={state.values.epoCity} required />
          <TextField label={t("postalCode")} name="epoPostalCode" defaultValue={state.values.epoPostalCode} required />
        </div>
        <label className="iv-checkbox-row">
          <input name="epoAddressConfirmed" type="checkbox" value="yes" defaultChecked={state.values.epoAddressConfirmed === "yes"} required />
          {t("confirmEpoAddress")}
        </label>
      </>}
    </fieldset>}
    <FormError error={state.error} />
    {state.values.saved === "yes" && <p role="status">{t("saved")}</p>}
    <Button type="submit" disabled={pending}>{t(pending ? "saving" : "save")}</Button>
  </form>;
}
