"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import type { PersonType } from "@/application/companies";
import { useTranslations } from "next-intl";
import type {
  CompanyFilingDefaults,
  ResolvedEpoAddress,
} from "@/application/company-filing-defaults";
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
  epoAddress,
  finalized,
}: {
  companyId: string;
  format: EpoFormat;
  period: string;
  preparedOn: string;
  personType: PersonType;
  defaults: CompanyFilingDefaults | null;
  epoAddress: ResolvedEpoAddress | null;
  finalized: boolean;
}) {
  const t = useTranslations("epoExport");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filingDetailsComplete = Boolean(defaults?.taxOffice) && (personType === "natural" || Boolean(
    defaults?.signatoryFirstName && defaults.signatoryLastName && defaults.signatoryCapacity,
  ));
  const [editing, setEditing] = useState(!filingDetailsComplete);
  const serializedAddress = epoAddress
    ? `${epoAddress.address.streetName} ${epoAddress.address.houseNumber}${epoAddress.address.orientationNumber ? `/${epoAddress.address.orientationNumber}` : ""}, ${epoAddress.address.postalCode} ${epoAddress.address.city}`
    : null;

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
            "epo_address_required",
            "stale_report",
            "report_finalized",
            "report_not_finalized",
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
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const prefix = finalized ? "" : "DRAFT_";
      link.download = disposition.match(/filename="([^"]+)"/)?.[1]
        ?? `${prefix}${String(form.get("format")).toUpperCase()}_${period}.xml`;
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
      <div className={`iv-notice ${finalized ? "iv-notice-info" : "iv-notice-warning"}`} role="note">
        <strong>{t(finalized ? "finalNoticeTitle" : "draftWarningTitle")}</strong>
        <p>{t(finalized ? "finalNotice" : "draftWarning")}</p>
      </div>
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
        <dl className="epo-export-summary">
          <div><dt>{t("taxOffice")}</dt><dd>{defaults?.taxOffice ? t(`taxOffices.${defaults.taxOffice}`) : t("notSet")}</dd></div>
          {personType === "legal" && <div><dt>{t("signatory")}</dt><dd>{defaults?.signatoryFirstName
            ? `${defaults.signatoryFirstName} ${defaults.signatoryLastName} · ${defaults.signatoryCapacity}`
            : t("notSet")}</dd></div>}
          <div><dt>{t("email")}</dt><dd>{defaults?.email ?? t("notSet")}</dd></div>
          <div><dt>{t("phone")}</dt><dd>{defaults?.phone ?? t("notSet")}</dd></div>
          <div><dt>{t("serializedAddress")}</dt><dd>{serializedAddress ?? t("epoAddressMissing")}</dd></div>
          {epoAddress && <div><dt>{t("addressSource")}</dt><dd>{t(`addressSources.${epoAddress.source}`)}</dd></div>}
        </dl>
        {!epoAddress && <div className="iv-notice iv-notice-warning" role="alert">
          <p>{t("epoAddressRequired")}</p>
          <Link href={`/companies/${companyId}/settings#filing-defaults`}>{t("completeEpoAddress")}</Link>
        </div>}
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
          {filingDetailsComplete && <Button type="button" variant="secondary" onClick={() => setEditing(false)}>{t("useSaved")}</Button>}
        </> : <Button type="button" variant="secondary" onClick={() => setEditing(true)}>{t("editForExport")}</Button>}
        <FormError error={error} />
        <Button type="submit" disabled={pending || !epoAddress} icon="report">
          {t(pending ? "preparing" : "download")}
        </Button>
      </form>
    </article>
  );
}
