"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  changeReportingYearFrequencyAction,
  deleteReportingYearAction,
  generateReportingYearsAction,
  setFirstReportingMonthAction,
  type FormState,
} from "@/app/actions";
import type { ReportingYear } from "@/application/companies";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { Notice } from "@/components/notice";
import { TextField } from "@/components/text-field";
import { formatMonthName } from "@/lib/format-date";

const QUARTER_START_MONTHS = [1, 4, 7, 10];
const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);

/** An Administrator's list of the Company's Reporting Years with their changes, and the generate form. */
export function ReportingYears({ companyId, years, suggestedYear }: {
  companyId: string;
  years: ReportingYear[];
  /** A year to prefill, such as the missing year a Document links to. */
  suggestedYear: number;
}) {
  const t = useTranslations("company");
  return <>
    {years.length === 0 ? <p className="iv-muted">{t("noReportingYears")}</p> : <div className="reporting-years-workspace">
      <table className="iv-table reporting-years">
        <caption className="sr-only">{t("reportingYearsTitle")}</caption>
        <thead><tr>
          <th scope="col">{t("reportingYear")}</th>
          <th scope="col">{t("filingFrequency")}</th>
          <th scope="col">{t("firstReportingMonth")}</th>
          <th scope="col"><span className="sr-only">{t("reportingYearActions")}</span></th>
        </tr></thead>
        <tbody>{years.map((year, index) => <tr key={year.year}>
          <th scope="row">{year.year}</th>
          <td><FrequencyForm companyId={companyId} year={year} /></td>
          <td>{index !== 0 && <span className="reporting-year-cell-label">{t("firstReportingMonth")}</span>}{index === 0 ? <FirstMonthForm companyId={companyId} year={year} /> : <MonthName month={year.firstMonth} />}</td>
          <td><DeleteForm companyId={companyId} year={year.year} /></td>
        </tr>)}</tbody>
      </table>
    </div>}
    <GenerateForm companyId={companyId} suggestedYear={suggestedYear} />
  </>;
}

function MonthName({ month }: { month: number }) {
  return formatMonthName(useLocale(), month);
}

function useCommand(action: (state: FormState, formData: FormData) => Promise<FormState>) {
  return useActionState(action, { error: null, values: {} });
}

/** Deleting a year takes its Documents out of their Reporting Periods, so it is confirmed first. */
function DeleteForm({ companyId, year }: { companyId: string; year: number }) {
  const t = useTranslations("company");
  const [state, action, pending] = useCommand(deleteReportingYearAction);
  return <form action={action} className="reporting-year-change">
    <input name="companyId" type="hidden" value={companyId} />
    <input name="year" type="hidden" value={year} />
    <label className="iv-checkbox-row">
      <input name="confirmed" type="checkbox" required defaultChecked={state.values.confirmed === "on"} />
      <span>{t("confirmReportingYearDeletion", { year })}</span>
    </label>
    <Button size="sm" type="submit" variant="danger" disabled={pending}>{t("deleteReportingYear", { year })}</Button>
    <FormError error={state.error} />
  </form>;
}

function FrequencyForm({ companyId, year }: { companyId: string; year: ReportingYear }) {
  const t = useTranslations("company");
  const [state, action, pending] = useCommand(changeReportingYearFrequencyAction);
  return <form action={action} className="reporting-year-change">
    <input name="companyId" type="hidden" value={companyId} />
    <input name="year" type="hidden" value={year.year} />
    <label className="iv-field-label">
      {t("filingFrequency")}
    <select
      className="iv-input"
      aria-label={t("reportingYearFrequency", { year: year.year })}
      defaultValue={state.values.frequency ?? year.frequency}
      key={`${year.frequency}-${state.values.frequency}`}
      name="frequency"
    >
      <option value="monthly">{t("monthly")}</option>
      <option value="quarterly">{t("quarterly")}</option>
    </select>
    </label>
    <Button size="sm" type="submit" disabled={pending}>{t("changeReportingYearFrequency")}</Button>
    <FormError error={state.error} />
  </form>;
}

function FirstMonthForm({ companyId, year }: { companyId: string; year: ReportingYear }) {
  const t = useTranslations("company");
  const locale = useLocale();
  const [state, action, pending] = useCommand(setFirstReportingMonthAction);
  const months = year.frequency === "quarterly" ? QUARTER_START_MONTHS : MONTHS;
  return <form action={action} className="reporting-year-change">
    <input name="companyId" type="hidden" value={companyId} />
    <input name="year" type="hidden" value={year.year} />
    <label className="iv-field-label">
      {t("firstReportingMonth")}
    <select
      className="iv-input"
      aria-label={t("firstReportingMonthOf", { year: year.year })}
      defaultValue={state.values.firstMonth ?? year.firstMonth}
      key={`${year.frequency}-${year.firstMonth}-${state.values.firstMonth}`}
      name="firstMonth"
    >
      {months.map((month) => <option key={month} value={month}>{formatMonthName(locale, month)}</option>)}
    </select>
    </label>
    <Button size="sm" type="submit" disabled={pending}>{t("changeReportingYearFirstMonth")}</Button>
    <FormError error={state.error} />
  </form>;
}

function GenerateForm({ companyId, suggestedYear }: { companyId: string; suggestedYear: number }) {
  const t = useTranslations("company");
  const [state, action, pending] = useActionState(generateReportingYearsAction, {
    error: null,
    values: { fromYear: String(suggestedYear), toYear: String(suggestedYear), frequency: "monthly" },
  });
  const generated = state.values.generated;
  const skipped = state.values.skipped;
  return <form action={action} className="form settings-form" key={JSON.stringify(state.values)}>
    <p><strong>{t("generateReportingYearsTitle")}</strong><br />{t("generateReportingYearsIntro")}</p>
    <input name="companyId" type="hidden" value={companyId} />
      <TextField
        label={t("fromYear")}
        name="fromYear"
        inputMode="numeric"
        pattern="20[0-9]{2}"
        maxLength={4}
        required
        defaultValue={state.values.fromYear ?? String(suggestedYear)}
      />
      <TextField
        label={t("toYear")}
        name="toYear"
        inputMode="numeric"
        pattern="20[0-9]{2}"
        maxLength={4}
        defaultValue={state.values.toYear ?? ""}
        hint={t("toYearHint")}
      />
      <label className="iv-field-label">
        {t("filingFrequency")}
        <select name="frequency" defaultValue={state.values.frequency ?? "monthly"} required>
          <option value="monthly">{t("monthly")}</option>
          <option value="quarterly">{t("quarterly")}</option>
        </select>
      </label>
    <FormError error={state.error} />
    {generated !== undefined && <Notice tone="success">
      {generated ? t("reportingYearsGenerated", { years: generated }) : t("noReportingYearsGenerated")}
      {skipped ? ` ${t("reportingYearsSkipped", { years: skipped })}` : ""}
    </Notice>}
    <Button variant="primary" type="submit" disabled={pending}>{t("generateReportingYears")}</Button>
  </form>;
}
