"use client";

import { useState, type FormEvent } from "react";
import type { PersonType } from "@/application/companies";
import { useTranslations } from "next-intl";
import type { CompanyFilingDefaults } from "@/application/company-filing-defaults";
import { TAX_OFFICES, type EpoFormat } from "@/application/epo-export-details";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

export function ExportForm({
  companyId,
  format,
  period,
  preparedOn,
  personType,
  defaults,
}: {
  companyId: string;
  format: EpoFormat;
  period: string;
  preparedOn: string;
  personType: PersonType;
  defaults: CompanyFilingDefaults | null;
}) {
  const t = useTranslations("epoExport");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultsComplete = Boolean(defaults?.taxOffice) && (personType === "natural" || Boolean(
    defaults?.signatoryFirstName && defaults.signatoryLastName && defaults.signatoryCapacity,
  ));
  const [editing, setEditing] = useState(!defaultsComplete);

  async function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/companies/${companyId}/vat-reports/${period}/xml`,
        { method: "POST", body: form },
      );
      if (response.redirected) {
        window.location.assign(response.url);
        return;
      }
      if (!response.ok) {
        const failure = await response.json();
        setError(
          [
            "report_not_found",
            "invalid_export_format",
            "invalid_export_details",
            "xml_invalid",
          ].includes(failure.error)
            ? failure.error
            : "export_failed",
        );
        return;
      }
      if (
        !response.headers.get("Content-Type")?.startsWith("application/xml")
      ) {
        setError("export_failed");
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${String(form.get("format")).toUpperCase()}-${period}.xml`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError("export_failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="vat-export-card">
      <span className="vat-section-label">{format.toUpperCase()}</span>
      <h3>{t(`formats.${format}`)}</h3>
      <p className="iv-muted">{t("description")}</p>
      <form className="form" onSubmit={download}>
        <input type="hidden" name="format" value={format} />
        <div className="form-row">
          <TextField
            type="date"
            label={t("preparedOn")}
            name="preparedOn"
            required
            defaultValue={preparedOn}
          />
        </div>
        <p>{t("personType")}: {t(personType === "legal" ? "legalPerson" : "naturalPerson")}</p>
        {defaults && <dl className="epo-export-summary">
          <div><dt>{t("taxOffice")}</dt><dd>{defaults.taxOffice ? t(`taxOffices.${defaults.taxOffice}`) : t("notSet")}</dd></div>
          {personType === "legal" && <div><dt>{t("signatory")}</dt><dd>{defaults.signatoryFirstName
            ? `${defaults.signatoryFirstName} ${defaults.signatoryLastName} · ${defaults.signatoryCapacity}`
            : t("notSet")}</dd></div>}
          <div><dt>{t("email")}</dt><dd>{defaults.email ?? t("notSet")}</dd></div>
          <div><dt>{t("phone")}</dt><dd>{defaults.phone ?? t("notSet")}</dd></div>
        </dl>}
        {editing ? <>
          <label className="iv-field-label">
            {t("taxOffice")}
            <select name="taxOffice" required defaultValue={defaults?.taxOffice ?? ""}>
              <option value="">{t("choose")}</option>
              {TAX_OFFICES.map((code) => (
                <option key={code} value={code}>{t(`taxOffices.${code}`)}</option>
              ))}
            </select>
          </label>
          {personType === "legal" && <fieldset>
            <legend>{t("signatory")}</legend>
            <div className="form-row">
              <TextField label={t("firstName")} name="signatoryFirstName" required maxLength={20} defaultValue={defaults?.signatoryFirstName ?? ""} />
              <TextField label={t("lastName")} name="signatoryLastName" required maxLength={36} defaultValue={defaults?.signatoryLastName ?? ""} />
            </div>
            <TextField label={t("capacity")} name="signatoryCapacity" required maxLength={40} defaultValue={defaults?.signatoryCapacity ?? ""} />
          </fieldset>}
          <div className="form-row">
            <TextField label={t("email")} name="email" type="email" maxLength={255} defaultValue={defaults?.email ?? ""} />
            <TextField label={t("phone")} name="phone" type="tel" maxLength={14} defaultValue={defaults?.phone ?? ""} />
          </div>
          {defaultsComplete && <Button type="button" variant="secondary" onClick={() => setEditing(false)}>{t("useSaved")}</Button>}
        </> : <Button type="button" variant="secondary" onClick={() => setEditing(true)}>{t("editForExport")}</Button>}
        <FormError error={error} />
        <Button type="submit" disabled={pending} icon="report">
          {t(pending ? "preparing" : "download")}
        </Button>
      </form>
    </article>
  );
}
