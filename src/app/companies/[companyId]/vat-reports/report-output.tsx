import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Money } from "@/components/money";
import {
  readinessDocumentCounts,
  type ReportingPeriodReadiness,
} from "@/application/reporting-period-readiness";
import type { VatReport } from "@/application/vat-reports";

export async function ReportAmount({
  amount,
  companyId,
  documentIds,
  documents,
}: {
  amount: string;
  companyId: string;
  documentIds: string[];
  documents: VatReport["documents"];
}) {
  const [locale, t] = await Promise.all([
    getLocale(),
    getTranslations("vatReports"),
  ]);
  const money = <Money amount={Number(amount)} currency="CZK" locale={locale} />;
  if (documentIds.length === 0) return money;
  return (
    <details className="report-drilldown">
      <summary>{money}</summary>
      <ul aria-label={t("contributors")}>
        {documentIds.map((documentId) => {
          const document = documents.find((candidate) => candidate.id === documentId);
          return (
            <li key={documentId}>
              <Link href={`/companies/${companyId}/documents/${documentId}`}>
                {document?.payload?.documentNumber ?? t("documentFallback")}
              </Link>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export async function ReportIssues({
  companyId,
  readiness,
  report,
}: {
  companyId: string;
  readiness: ReportingPeriodReadiness;
  report: VatReport;
}) {
  const t = await getTranslations("vatReports");
  const counts = readinessDocumentCounts(readiness);
  const documentLink = (documentId: string) => {
    const document = report.documents.find((candidate) => candidate.id === documentId);
    return (
      <Link href={`/companies/${companyId}/documents/${documentId}`}>
        {document?.payload?.documentNumber ?? t("documentFallback")}
      </Link>
    );
  };
  return (
    <section className="vat-output-issues" aria-labelledby="vat-output-issues-title">
      <header>
        <div>
          <span className="vat-section-label">{t("beforeExport")}</span>
          <h2 id="vat-output-issues-title">{t("issuesTitle")}</h2>
          <p>{t("issuesHint")}</p>
        </div>
        <strong className={counts.blockers ? "has-blockers" : "is-ready"}>
          {counts.blockers
            ? t("blockerCount", { count: counts.blockers })
            : t("ready")}
        </strong>
      </header>
      <div className="vat-output-issue-columns">
        <div>
          <h3>{t("readinessBlockers")}</h3>
          {readiness.blockers.length === 0 ? (
            <p>{t("noReadinessBlockers")}</p>
          ) : (
            <ul>
              {readiness.blockers.map((blocker, index) => (
                <li key={`${blocker.documentId}:${blocker.code}:${index}`}>
                  {documentLink(blocker.documentId)} · {t(`blockerReasons.${blocker.code}`)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3>{t("excluded")}</h3>
          {report.result.excludedDocuments.length === 0 ? (
            <p>{t("noExclusions")}</p>
          ) : (
            <ul>
              {report.result.excludedDocuments.map((excluded) => (
                <li key={excluded.documentId}>
                  {documentLink(excluded.documentId)} · {t(`reasons.${excluded.reason}`)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
