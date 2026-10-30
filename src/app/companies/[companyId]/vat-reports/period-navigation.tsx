import Link from "next/link";
import { withCompanyReturnTo } from "@/application/return-context";
import { getTranslations } from "next-intl/server";
import type { ReportingPeriodSummary } from "@/application/reporting-period-readiness";

type PeriodDestination =
  | "processing"
  | "vatReturn"
  | "controlStatement"
  | "exportHistory";

function destinationHref(
  companyId: string,
  period: string,
  destination: PeriodDestination,
) {
  if (destination === "processing")
    return `/companies/${companyId}/vat-reports?period=${period}`;
  const segment = {
    vatReturn: "vat-return",
    controlStatement: "control-statement",
    exportHistory: "exports",
  }[destination];
  return `/companies/${companyId}/vat-reports/${period}/${segment}`;
}

export async function PeriodNavigation({
  companyId,
  period,
  active,
  reportAvailable,
  returnTo,
}: {
  companyId: string;
  period: string;
  active: PeriodDestination;
  reportAvailable: boolean;
  returnTo?: string | null;
}) {
  const t = await getTranslations("vatReports");
  const destinations: PeriodDestination[] = [
    "processing",
    "vatReturn",
    "controlStatement",
    "exportHistory",
  ];
  return (
    <nav className="vat-period-navigation" aria-label={t("periodNavigation")}>
      {destinations.map((destination) => {
        const disabled = destination !== "processing" && !reportAvailable;
        const label = t(`destinations.${destination}`);
        const origin = active === "processing" && destination === "exportHistory"
          ? returnTo?.replace(/#vat-step-outputs$/, "#vat-step-export") : returnTo;
        return disabled ? (
          <span aria-disabled="true" key={destination}>
            {label}
          </span>
        ) : (
          <Link
            aria-current={active === destination ? "page" : undefined}
            href={destination === "processing" ? destinationHref(companyId, period, destination) : withCompanyReturnTo(companyId, destinationHref(companyId, period, destination), origin)}
            key={destination}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export async function PeriodSelector({
  companyId,
  period,
  periods,
}: {
  companyId: string;
  period: string;
  periods: ReportingPeriodSummary[];
}) {
  const t = await getTranslations("vatReports");
  const periodIndex = periods.findIndex((candidate) => candidate.period === period);
  const previousPeriod = periods[periodIndex - 1]?.period;
  const nextPeriod = periods[periodIndex + 1]?.period;
  return (
    <section className="vat-period-toolbar" aria-label={t("selectPeriod")}>
      <Link
        aria-disabled={!previousPeriod}
        className={`vat-period-previous${!previousPeriod ? " is-disabled" : ""}`}
        href={
          previousPeriod
            ? `/companies/${companyId}/vat-reports?period=${previousPeriod}`
            : `?period=${period}`
        }
      >
        {t("previous")}
      </Link>
      <form key={period}>
        <label htmlFor="reporting-period">
          {t("period")}
          <select defaultValue={period} id="reporting-period" name="period">
            {periods.map((candidate) => (
              <option key={candidate.period} value={candidate.period}>
                {candidate.period}
              </option>
            ))}
          </select>
        </label>
        <button className="iv-btn iv-btn-secondary iv-btn-md" type="submit">
          {t("show")}
        </button>
      </form>
      <Link
        aria-disabled={!nextPeriod}
        className={`vat-period-next${!nextPeriod ? " is-disabled" : ""}`}
        href={
          nextPeriod
            ? `/companies/${companyId}/vat-reports?period=${nextPeriod}`
            : `?period=${period}`
        }
      >
        {t("next")}
      </Link>
    </section>
  );
}
