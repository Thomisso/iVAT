"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { TextField } from "./text-field";

/** A request selection is explicit; hidden fields from another variant never become a profile. */
export function RepresentativeFields({ values, allowDefault = false, onChange }: {
  values: Record<string, string>; allowDefault?: boolean; onChange?: (fields: Record<string, string>) => void;
}) {
  const t = useTranslations("representation");
  const [mode, setMode] = useState(values.representativeMode ?? (allowDefault ? "default" : "off"));
  return <fieldset>
    <legend>{t("title")}</legend>
    <label className="iv-field">
      <span className="iv-field-label">{t("selection")}</span>
      <select name="representativeMode" value={mode} onChange={event => {
        const next = event.currentTarget.value;
        setMode(next);
        onChange?.({ representativeMode: next, representativeCode: next === "override" ? "4a" : "", representativePersonType: next === "override" ? "F" : "",
          representativeFirstName: values.representativeFirstName ?? "", representativeLastName: values.representativeLastName ?? "",
          representativeBirthDate: values.representativeBirthDate ?? "", representativeEvidenceNumber: values.representativeEvidenceNumber ?? "" });
      }}>
        {allowDefault && <option value="default">{t("default")}</option>}
        <option value="off">{t("off")}</option>
        <option value="override">{t("generalNatural")}</option>
      </select>
    </label>
    {mode === "override" && <>
      <input type="hidden" name="representativeCode" value="4a" />
      <input type="hidden" name="representativePersonType" value="F" />
      <div className="form-row">
        <TextField label={t("firstName")} name="representativeFirstName" maxLength={20} defaultValue={values.representativeFirstName ?? ""} />
        <TextField label={t("lastName")} name="representativeLastName" maxLength={36} defaultValue={values.representativeLastName ?? ""} />
      </div>
      <div className="form-row">
        <TextField label={t("birthDate")} type="date" name="representativeBirthDate" defaultValue={values.representativeBirthDate ?? ""} />
        <TextField label={t("evidenceNumber")} name="representativeEvidenceNumber" maxLength={36} defaultValue={values.representativeEvidenceNumber ?? ""} />
      </div>
      <p className="iv-field-hint">{t("identityHint")}</p>
    </>}
    <p className="iv-field-hint">{t("scopeHint")}</p>
  </fieldset>;
}
