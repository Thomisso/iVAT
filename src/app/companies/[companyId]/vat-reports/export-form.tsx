"use client";

import { RepresentativeFields } from "@/components/representative-fields";
import { representativeFields } from "@/application/epo-representative";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
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
import { exportTiming } from "@/application/epo-export-timing";
import { pragueDate } from "@/application/reporting-periods";
import { useCurrentExportContext } from "./export-context";
import { formatDate } from "@/lib/format-date";

function subscribeToClock(changed: () => void) {
  const timer = window.setInterval(changed, 30_000);
  window.addEventListener("focus", changed);
  return () => { window.clearInterval(timer); window.removeEventListener("focus", changed); };
}
const todayInPrague = () => pragueDate(new Date().toISOString());

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
  const currentExport = useCurrentExportContext();
  const t = useTranslations("epoExport");
  const wizardCopy = useTranslations("vatReports.wizard");
  const wizard = presentation === "wizard";
  const [opened, setOpened] = useState(!wizard);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportPreparedOn, setExportPreparedOn] = useState(preparedOn);
  // The server supplies today's initial preparation date; the browser then
  // follows its clock, including a Prague midnight while the form stays open.
  const today = useSyncExternalStore(subscribeToClock, todayInPrague, () => preparedOn);
  const timing = exportTiming({ period, format, personType, preparedOn: exportPreparedOn, today });
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const filingDetailsComplete = Boolean(defaults?.taxOffice)
    && (!defaults?.territorialOffice || isTerritorialOffice(defaults.taxOffice ?? "", defaults.territorialOffice))
    && (format !== "dphdp3" || isEconomicActivity(defaults?.economicActivity ?? ""))
    && (personType === "natural" || Boolean(
    defaults?.signatoryFirstName && defaults.signatoryLastName && defaults.signatoryCapacity,
  ));
  const [representationRevision, setRepresentationRevision] = useState(0);
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
    Object.entries(currentExport?.details ?? {}).forEach(([key, value]) => form.set(key, value));
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
      {timing.warnings.length > 0 && <div aria-label={t("timingWarnings")} aria-live="polite" className="iv-notice iv-notice-warning vat-export-timing" role="note">
        <ul>{timing.warnings.map((warning) => <li key={warning}>{t(`timing.${warning}`, { deadline: timing.deadline ? formatDate(timing.deadline) : "" })}</li>)}</ul>
      </div>}
      <form className="form" onSubmit={download} onChange={event => {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
          if (!target.name || target.name === "preparedOn" || target.name === "representativeMode") return;
          currentExport?.update({ [target.name]: target.value, ...(target.name === "taxOffice" ? { territorialOffice: "" } : {}) });
        }
      }}>
        <input type="hidden" name="format" value={format} />
        <input type="hidden" name="kind" value={finalized ? "final" : "draft"} />
        {!showFields && <input type="hidden" name="preparedOn" value={exportPreparedOn} />}
        {showFields && <>
        <div className="form-row">
          <DateInput
            label={t("preparedOn")}
            name="preparedOn"
            required
            defaultValue={exportPreparedOn}
            onValueChange={value => { setExportPreparedOn(value); currentExport?.update({ preparedOn: value }); }}
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
          <div><dt>{t("representative")}</dt><dd>{defaults?.representative ? `${defaults.representative.firstName} ${defaults.representative.lastName} · ${defaults.representative.code}/${defaults.representative.personType}` : t("noRepresentative")}</dd></div>
          <div><dt>{t("email")}</dt><dd>{defaults?.email ?? t("notSet")}</dd></div>
          <div><dt>{t("phone")}</dt><dd>{defaults?.phone ?? t("notSet")}</dd></div>
          <div><dt>{t("serializedAddress")}</dt><dd>{serializedAddress ?? t("epoAddressMissing")}</dd></div>
          {epoAddress && <div><dt>{t("addressSource")}</dt><dd>{t(`addressSources.${epoAddress.source}`)}</dd></div>}
        </dl>
        <RepresentativeFields key={representationRevision} allowDefault values={{ ...representativeFields(defaults?.representative), representativeMode: "default" }} onChange={fields => currentExport?.update(fields)} />
        {!epoAddress && !wizard && <div className="iv-notice iv-notice-warning" role="alert">
          <p>{t("epoAddressRequired")}</p>
          <Link href={`/companies/${companyId}/settings/vat#filing-defaults`}>{t("completeEpoAddress")}</Link>
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
          {filingDetailsComplete && <Button type="button" variant="secondary" onClick={() => { currentExport?.reset(); setRepresentationRevision(value => value + 1); setEditing(false); if (wizard) setOpened(false); }}>{t("useSaved")}</Button>}
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
