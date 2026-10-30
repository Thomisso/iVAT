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
import { CommandButton } from "@/components/command-button";
import { FormError } from "@/components/form-error";
import { Notice } from "@/components/notice";
import { TextField } from "@/components/text-field";

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
    {years.length === 0 ? <p className="iv-muted">{t("noReportingYears")}</p> : <div className="iv-table-wrap">
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
          <td>{index === 0 ? <FirstMonthForm companyId={companyId} year={year} /> : <MonthName month={year.firstMonth} />}</td>
          <td>
            <CommandButton
              action={deleteReportingYearAction}
              fields={{ companyId, year: String(year.year) }}
              variant="danger"
              size="sm"
            >{t("deleteReportingYear", { year: year.year })}</CommandButton>
          </td>
        </tr>)}</tbody>
      </table>
    </div>}
    <GenerateForm companyId={companyId} suggestedYear={suggestedYear} />
  </>;
}

const monthName = (locale: string, month: number) =>
  new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, month - 1, 1)));

function MonthName({ month }: { month: number }) {
  return monthName(useLocale(), month);
}

function useCommand(action: (state: FormState, formData: FormData) => Promise<FormState>) {
  return useActionState(action, { error: null, values: {} });
}

function FrequencyForm({ companyId, year }: { companyId: string; year: ReportingYear }) {
  const t = useTranslations("company");
  const [state, action, pending] = useCommand(changeReportingYearFrequencyAction);
  return <form action={action} className="reporting-year-change">
    <input name="companyId" type="hidden" value={companyId} />
    <input name="year" type="hidden" value={year.year} />
    <select
      aria-label={t("reportingYearFrequency", { year: year.year })}
      defaultValue={year.frequency}
      key={year.frequency}
      name="frequency"
    >
      <option value="monthly">{t("monthly")}</option>
      <option value="quarterly">{t("quarterly")}</option>
    </select>
    <Button size="sm" type="submit" disabled={pending}>{t("changeReportingYear")}</Button>
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
    <select
      aria-label={t("firstReportingMonthOf", { year: year.year })}
      defaultValue={year.firstMonth}
      key={`${year.frequency}-${year.firstMonth}`}
      name="firstMonth"
    >
      {months.map((month) => <option key={month} value={month}>{monthName(locale, month)}</option>)}
    </select>
    <Button size="sm" type="submit" disabled={pending}>{t("changeReportingYear")}</Button>
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
