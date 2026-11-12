import { Money } from "./money";
import { formatDate } from "@/lib/format-date";
import { getTranslations } from "next-intl/server";
import type { DocumentReporting } from "@/application/document-reporting";

/** Approval and historical report snapshots are deliberately separate facts. */
export async function DocumentReportingSummary({ reporting, compact = false }: { reporting: DocumentReporting; compact?: boolean }) {
  const t = await getTranslations("documentReporting");
  const mapping = reporting.mapping;
  return <div className={`document-reporting${compact ? " is-compact" : ""}`} role="group" aria-label={t("liveTitle")}>
    {!compact && <strong>{t("liveTitle")}</strong>}
    <p>{t("period", { period: reporting.period ?? t("unassigned") })}</p>
    {reporting.proportionalDeduction && <>
      <p>{t("proportionalRatio", { percentage: reporting.proportionalDeduction.percentage })}</p>
      <p>{t("proportionalClaimed")} <Money amount={reporting.proportionalDeduction.netAmount} /> {t("amountSeparator")} <Money amount={reporting.proportionalDeduction.vatAmount} /></p>
    </>}
    {!compact && reporting.claimDeadline && <>
      <p>{t("claimLastFilingDate", { date: formatDate(reporting.claimDeadline.lastFilingDate) })}</p>
      <p>{t("claimEvaluatedOn", { date: formatDate(reporting.claimDeadline.evaluatedOn) })}</p>
      {reporting.claimDeadline.latestOrdinaryPeriod && <p>{t("claimLatestPeriod", { period: reporting.claimDeadline.latestOrdinaryPeriod })}</p>}
      <p className="iv-muted">{t("claimFilingNote")}</p>
    </>}
    <p><strong>{t(reporting.included ? "included" : "excluded")}</strong>
      {reporting.exclusionReason && <> · {t(`reasons.${reporting.exclusionReason}`)}</>}
      {reporting.exclusionDetail && <> {t(`details.${reporting.exclusionDetail}`)}</>}
    </p>
    <p><strong>{t(reporting.included ? "derived" : "proposed")}</strong></p>
    <p>{t("returnLines", { lines: mapping.vatReturnLines.join(", ") || t("unknown") })}
      {mapping.vatReturnUnknownReason && <> · {t(`unknownReasons.${mapping.vatReturnUnknownReason}`)}</>}
    </p>
    <p>{t("section", { section: mapping.controlStatementSection ?? t("unknown") })}
      {mapping.controlStatementUnknownReason && <> · {t(`unknownReasons.${mapping.controlStatementUnknownReason}`)}</>}
    </p>
    <p>{t("blocking", { count: reporting.blockingFindings.length })} · {t("advisories", { count: reporting.advisoryFindings.length })}</p>
    {!compact && <small>{t("liveNote")}</small>}
  </div>;
}
