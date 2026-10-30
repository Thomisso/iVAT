"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { TAX_OFFICES } from "@/application/epo-export-details";
import { ECONOMIC_ACTIVITIES, TERRITORIAL_OFFICES } from "@/application/epo-catalogues";
import { TextField } from "./text-field";

/** Shared Company defaults and one-export selection; a new parent clears its old child. */
export function FilingOfficeFields({
  taxOffice: initialTaxOffice = "",
  territorialOffice: initialTerritorialOffice = "",
  economicActivity = "",
  requireTaxOffice = false,
  requireEconomicActivity = false,
}: {
  taxOffice?: string | null;
  territorialOffice?: string | null;
  economicActivity?: string | null;
  requireTaxOffice?: boolean;
  requireEconomicActivity?: boolean;
}) {
  const t = useTranslations("epoExport");
  const [taxOffice, setTaxOffice] = useState(initialTaxOffice ?? "");
  const [territorialOffice, setTerritorialOffice] = useState(initialTerritorialOffice ?? "");
  const activitiesId = useId();
  return <>
    <div className="form-row">
      <label className="iv-field-label">
        {t("taxOffice")}
        <select name="taxOffice" value={taxOffice} required={requireTaxOffice} onChange={(event) => {
          setTaxOffice(event.currentTarget.value);
          setTerritorialOffice("");
        }}>
          <option value="">{t("choose")}</option>
          {TAX_OFFICES.map((code) => <option key={code} value={code}>{t(`taxOffices.${code}`)}</option>)}
        </select>
      </label>
      <label className="iv-field-label">
        {t("territorialOffice")}
        <select name="territorialOffice" value={territorialOffice} disabled={!taxOffice} onChange={(event) => setTerritorialOffice(event.currentTarget.value)}>
          <option value="">{t("notSet")}</option>
          {TERRITORIAL_OFFICES.filter((office) => office.taxOffice === taxOffice).map((office) =>
            <option key={office.code} value={office.code}>{office.name}</option>)}
        </select>
      </label>
    </div>
    <TextField label={t("economicActivity")} name="economicActivity" defaultValue={economicActivity ?? ""} list={activitiesId} inputMode="numeric" maxLength={6} required={requireEconomicActivity} />
    <datalist id={activitiesId}>
      {ECONOMIC_ACTIVITIES.map((activity) => <option key={activity.code} value={activity.code}>{activity.name}</option>)}
    </datalist>
  </>;
}
