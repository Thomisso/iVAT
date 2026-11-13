"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { TextField } from "./text-field";

/** A request selection is explicit; hidden fields from another variant never become a profile. */
export function RepresentativeFields({ values, allowDefault = false, onChange }: {
  values: Record<string, string>; allowDefault?: boolean; onChange?: (fields: Record<string, string>) => void;
}) {
  const t = useTranslations("representation");
  const [selection, setSelection] = useState(values.representativeMode === "override" ? (values.representativePersonType === "P" ? `${values.representativeCode}/P` : values.representativeCode ?? "4a") : values.representativeMode ?? (allowDefault ? "default" : "off"));
  const [fields, setFields] = useState(values);
  const variants: Record<string, { code: string; personType: string }> = {
    "4a": { code: "4a", personType: "F" }, "4b": { code: "4b", personType: "F" },
    "4a/P": { code: "4a", personType: "P" }, "4c/P": { code: "4c", personType: "P" },
  };
  const variant = variants[selection];
  const mode = variant ? "override" : selection;
  return <fieldset>
    <legend>{t("title")}</legend>
    <label className="iv-field">
      <span className="iv-field-label">{t("selection")}</span>
      <input type="hidden" name="representativeMode" value={mode} />
      <select name="representativeVariant" value={selection} onChange={event => {
        const next = event.currentTarget.value;
        setSelection(next);
        const cleared = { representativeFirstName: "", representativeLastName: "", representativeBirthDate: "", representativeEvidenceNumber: "",
          representativeName: "", representativeIco: "", representativeSignatoryFirstName: "", representativeSignatoryLastName: "", representativeSignatoryCapacity: "" };
        setFields(cleared);
        onChange?.({ ...cleared, representativeMode: variants[next] ? "override" : next,
          representativeCode: variants[next]?.code ?? "", representativePersonType: variants[next]?.personType ?? "" });
      }}>
        {allowDefault && <option value="default">{t("default")}</option>}
        <option value="off">{t("off")}</option>
        <option value="4a">{t("generalNatural")}</option>
        <option value="4b">{t("professionalNatural")}</option>
        <option value="4a/P">{t("generalLegal")}</option>
        <option value="4c/P">{t("professionalLegal")}</option>
      </select>
    </label>
    {mode === "override" && <div key={selection}>
      <input type="hidden" name="representativeCode" value={variant.code} />
      <input type="hidden" name="representativePersonType" value={variant.personType} />
      {variant.personType === "P" ? <>
        <TextField label={t("name")} name="representativeName" maxLength={255} defaultValue={fields.representativeName ?? ""} />
        <TextField label={t("ico")} name="representativeIco" maxLength={10} defaultValue={fields.representativeIco ?? ""} />
        <fieldset>
          <legend>{t("signatory")}</legend>
          <p className="iv-field-hint">{t("signatoryHint")}</p>
          <div className="form-row">
            <TextField label={t("signatoryFirstName")} name="representativeSignatoryFirstName" maxLength={20} defaultValue={fields.representativeSignatoryFirstName ?? ""} />
            <TextField label={t("signatoryLastName")} name="representativeSignatoryLastName" maxLength={36} defaultValue={fields.representativeSignatoryLastName ?? ""} />
          </div>
          <TextField label={t("signatoryCapacity")} name="representativeSignatoryCapacity" maxLength={40} defaultValue={fields.representativeSignatoryCapacity ?? ""} />
        </fieldset>
      </> : <><div className="form-row">
        <TextField label={t("firstName")} name="representativeFirstName" maxLength={20} defaultValue={fields.representativeFirstName ?? ""} />
        <TextField label={t("lastName")} name="representativeLastName" maxLength={36} defaultValue={fields.representativeLastName ?? ""} />
      </div>
      <div className="form-row">
        <TextField label={t("birthDate")} type="date" name="representativeBirthDate" defaultValue={fields.representativeBirthDate ?? ""} />
        <TextField label={t("evidenceNumber")} name="representativeEvidenceNumber" maxLength={36} defaultValue={fields.representativeEvidenceNumber ?? ""} />
      </div>
      <p className="iv-field-hint">{t("identityHint")}</p></>}
    </div>}
    <p className="iv-field-hint">{t("scopeHint")}</p>
  </fieldset>;
}
