import { getTranslations } from "next-intl/server";
import { isReportingPeriod, NO_REPORTING_PERIOD } from "@/application/reporting-periods";

/**
 * The Reporting Period dropdown of a list filter form: all, one period (newest
 * first) or No period. A selected period outside the generated years stays visible.
 */
export async function ReportingPeriodFilter({
  periods,
  selected,
}: {
  periods: readonly string[];
  selected?: string;
}) {
  const t = await getTranslations("periodFilter");
  const options = selected && isReportingPeriod(selected) && !periods.includes(selected)
    ? [...periods, selected].toSorted()
    : periods;
  return <label>
    <span>{t("label")}</span>
    <select className="iv-input" name="reportingPeriod" defaultValue={selected ?? ""}>
      <option value="">{t("all")}</option>
      {options.toReversed().map((period) => <option key={period} value={period}>{period}</option>)}
      <option value={NO_REPORTING_PERIOD}>{t("none")}</option>
    </select>
  </label>;
}
