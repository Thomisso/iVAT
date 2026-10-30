"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PersonType } from "@/application/companies";
import { useTranslations } from "next-intl";
import type {
  CompanyFilingDefaults,
  ResolvedEpoAddress,
} from "@/application/company-filing-defaults";
import type { EpoFormat } from "@/application/epo-export-details";
import { isEconomicActivity, isTerritorialOffice, TERRITORIAL_OFFICES } from "@/application/epo-catalogues";
import { FilingOfficeFields } from "@/components/filing-office-fields";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { DateInput } from "@/components/date-input";
import { FilingDefaultsForm } from "../settings/filing-defaults-form";
import { downloadVatReportXml } from "@/lib/vat-report-download";

export function ExportForm({
  companyId,
  format,
  period,
  preparedOn,
  personType,
  defaults,
  epoAddress,
  finalized,
  presentation = "detail",
  disabled = false,
  canEditFilingDefaults = false,
}: {
  companyId: string;
  format: EpoFormat;
  period: string;
  preparedOn: string;
  personType: PersonType;
  defaults: CompanyFilingDefaults | null;
  epoAddress: ResolvedEpoAddress | null;
  finalized: boolean;
  presentation?: "detail" | "wizard";
  disabled?: boolean;
  canEditFilingDefaults?: boolean;
}) {
  const t = useTranslations("epoExport");
  const wizardCopy = useTranslations("vatReports.wizard");
  const wizard = presentation === "wizard";
  const [opened, setOpened] = useState(!wizard);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const filingDetailsComplete = Boolean(defaults?.taxOffice)
    && (!defaults?.territorialOffice || isTerritorialOffice(defaults.taxOffice ?? "", defaults.territorialOffice))
    && (format !== "dphdp3" || isEconomicActivity(defaults?.economicActivity ?? ""))
    && (personType === "natural" || Boolean(
    defaults?.signatoryFirstName && defaults.signatoryLastName && defaults.signatoryCapacity,
  ));
  const [editing, setEditing] = useState(!filingDetailsComplete);
  const showFields = opened && (!wizard || Boolean(epoAddress));
  const serializedAddress = epoAddress
    ? `${epoAddress.address.streetName} ${epoAddress.address.houseNumber}${epoAddress.address.orientationNumber ? `/${epoAddress.address.orientationNumber}` : ""}, ${epoAddress.address.postalCode} ${epoAddress.address.city}`
    : null;

  async function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || pending) return;
    if (wizard && !opened && (!filingDetailsComplete || !epoAddress)) {
      setOpened(true);
      setEditing(true);
      return;
    }
    const form = new FormData(event.currentTarget);
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    try {
      const result = await downloadVatReportXml({
        url: `/companies/${companyId}/vat-reports/${period}/xml`,
        companyId, period, format, kind: finalized ? "final" : "draft",
        body: form, signal: controller.signal,
      });
      if (!result.ok) {
        if (wizard && result.error === "invalid_export_details") {
          setOpened(true);
          setEditing(true);
        }
        setError(result.error);
      }
    } catch {
      if (!controller.signal.aborted) setError("export_failed");
    } finally {
      request.current = null;
      setPending(false);
    }
  }

  return (
    <article className="vat-export-card" id={wizard ? undefined : "export"}>
      <span className="vat-section-label">{format.toUpperCase()}</span>
      <h3>{t(`formats.${format}`)}</h3>
      {opened && <><p className="iv-muted">{t("description")}</p>
      <div className={`iv-notice ${finalized ? "iv-notice-info" : "iv-notice-warning"}`} role="note">
        <strong>{t(finalized ? "finalNoticeTitle" : "draftWarningTitle")}</strong>
        <p>{t(finalized ? "finalNotice" : "draftWarning")}</p>
      </div></>}
      {wizard && opened && !epoAddress && <>
        <div className="iv-notice iv-notice-warning" role="alert">
          <p>{t("epoAddressRequired")}</p>
          {!canEditFilingDefaults && <p>{t("administratorAddressRequired")}</p>}
        </div>
        {canEditFilingDefaults && <FilingDefaultsForm companyId={companyId} personType={personType} defaults={defaults} epoOverrideRequired />}
      </>}
      <form className="form" onSubmit={download}>
        <input type="hidden" name="format" value={format} />
        <input type="hidden" name="kind" value={finalized ? "final" : "draft"} />
        {!showFields && <input type="hidden" name="preparedOn" value={preparedOn} />}
        {showFields && <>
        <div className="form-row">
          <DateInput
            label={t("preparedOn")}
            name="preparedOn"
            required
            defaultValue={preparedOn}
          />
        </div>
        <p>{t("personType")}: {t(personType === "legal" ? "legalPerson" : "naturalPerson")}</p>
        <dl className="epo-export-summary">
          <div><dt>{t("taxOffice")}</dt><dd>{defaults?.taxOffice ? t(`taxOffices.${defaults.taxOffice}`) : t("notSet")}</dd></div>
          <div><dt>{t("territorialOffice")}</dt><dd>{TERRITORIAL_OFFICES.find((office) => office.code === defaults?.territorialOffice)?.name ?? t("notSet")}</dd></div>
          {format === "dphdp3" && <div><dt>{t("economicActivity")}</dt><dd>{defaults?.economicActivity ?? t("notSet")}</dd></div>}
          {personType === "legal" && <div><dt>{t("signatory")}</dt><dd>{defaults?.signatoryFirstName
            ? `${defaults.signatoryFirstName} ${defaults.signatoryLastName} · ${defaults.signatoryCapacity}`
            : t("notSet")}</dd></div>}
          <div><dt>{t("email")}</dt><dd>{defaults?.email ?? t("notSet")}</dd></div>
          <div><dt>{t("phone")}</dt><dd>{defaults?.phone ?? t("notSet")}</dd></div>
          <div><dt>{t("serializedAddress")}</dt><dd>{serializedAddress ?? t("epoAddressMissing")}</dd></div>
          {epoAddress && <div><dt>{t("addressSource")}</dt><dd>{t(`addressSources.${epoAddress.source}`)}</dd></div>}
        </dl>
        {!epoAddress && !wizard && <div className="iv-notice iv-notice-warning" role="alert">
          <p>{t("epoAddressRequired")}</p>
          <Link href={`/companies/${companyId}/settings#filing-defaults`}>{t("completeEpoAddress")}</Link>
        </div>}
        {editing ? <>
          <FilingOfficeFields taxOffice={defaults?.taxOffice} territorialOffice={defaults?.territorialOffice} economicActivity={defaults?.economicActivity} requireTaxOffice requireEconomicActivity={format === "dphdp3"} />
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
          {filingDetailsComplete && <Button type="button" variant="secondary" onClick={() => { setEditing(false); if (wizard) setOpened(false); }}>{t("useSaved")}</Button>}
        </> : <Button type="button" variant="secondary" onClick={() => setEditing(true)}>{t("editForExport")}</Button>}
        </>}
        <FormError error={error} />
        <Button type="submit" disabled={pending || disabled || (opened && !epoAddress)} icon="report">
          {pending ? t("preparing") : wizard && !opened ? wizardCopy(format === "dphdp3" ? "exportVatReturn" : "exportControlStatement") : t("download")}
        </Button>
        {wizard && !opened && <Button type="button" disabled={pending || disabled} onClick={() => { setOpened(true); setEditing(true); }}>{t("editForExport")}</Button>}
      </form>
    </article>
  );
}
