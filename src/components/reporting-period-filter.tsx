import { getTranslations } from "next-intl/server";
import { NO_REPORTING_PERIOD } from "@/application/reporting-periods";

/** The Reporting Period dropdown of a list filter form: all, one period (newest first) or No period. */
export async function ReportingPeriodFilter({
  periods,
  selected,
}: {
  periods: readonly string[];
  selected?: string;
}) {
  const t = await getTranslations("periodFilter");
  return <label>
    <span>{t("label")}</span>
    <select className="iv-input" name="reportingPeriod" defaultValue={selected ?? ""}>
      <option value="">{t("all")}</option>
      {periods.toReversed().map((period) => <option key={period} value={period}>{period}</option>)}
      <option value={NO_REPORTING_PERIOD}>{t("none")}</option>
    </select>
  </label>;
}
