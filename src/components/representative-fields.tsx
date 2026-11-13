"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { TextField } from "./text-field";

/** A request selection is explicit; hidden fields from another variant never become a profile. */
export function RepresentativeFields({ values, allowDefault = false, onChange }: {
  values: Record<string, string>; allowDefault?: boolean; onChange?: (fields: Record<string, string>) => void;
}) {
  const t = useTranslations("representation");
  const [selection, setSelection] = useState(values.representativeMode === "override" ? values.representativeCode ?? "4a" : values.representativeMode ?? (allowDefault ? "default" : "off"));
  const [fields, setFields] = useState(values);
  const mode = selection === "4a" || selection === "4b" ? "override" : selection;
  return <fieldset>
    <legend>{t("title")}</legend>
    <label className="iv-field">
      <span className="iv-field-label">{t("selection")}</span>
      <input type="hidden" name="representativeMode" value={mode} />
      <select name="representativeVariant" value={selection} onChange={event => {
        const next = event.currentTarget.value;
        setSelection(next);
        const cleared = { representativeFirstName: "", representativeLastName: "", representativeBirthDate: "", representativeEvidenceNumber: "",
          representativeName: "", representativeIco: "" };
        setFields(cleared);
        onChange?.({ ...cleared, representativeMode: next === "4a" || next === "4b" ? "override" : next,
          representativeCode: next === "4a" || next === "4b" ? next : "", representativePersonType: next === "4a" || next === "4b" ? "F" : "" });
      }}>
        {allowDefault && <option value="default">{t("default")}</option>}
        <option value="off">{t("off")}</option>
        <option value="4a">{t("generalNatural")}</option>
        <option value="4b">{t("professionalNatural")}</option>
      </select>
    </label>
    {mode === "override" && <div key={selection}>
      <input type="hidden" name="representativeCode" value={selection} />
      <input type="hidden" name="representativePersonType" value="F" />
      <div className="form-row">
        <TextField label={t("firstName")} name="representativeFirstName" maxLength={20} defaultValue={fields.representativeFirstName ?? ""} />
        <TextField label={t("lastName")} name="representativeLastName" maxLength={36} defaultValue={fields.representativeLastName ?? ""} />
      </div>
      <div className="form-row">
        <TextField label={t("birthDate")} type="date" name="representativeBirthDate" defaultValue={fields.representativeBirthDate ?? ""} />
        <TextField label={t("evidenceNumber")} name="representativeEvidenceNumber" maxLength={36} defaultValue={fields.representativeEvidenceNumber ?? ""} />
      </div>
      <p className="iv-field-hint">{t("identityHint")}</p>
    </div>}
    <p className="iv-field-hint">{t("scopeHint")}</p>
  </fieldset>;
}
