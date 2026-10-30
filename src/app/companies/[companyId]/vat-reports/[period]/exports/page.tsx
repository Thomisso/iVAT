import { safeCompanyReturnTo, withCompanyReturnTo } from "@/application/return-context";
import { CompanyReturnLink } from "@/components/company-return-link";
import Link from "next/link";
import { Fragment } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany } from "@/application/companies";
import { listVatReportArtifacts } from "@/application/epo-export";
import { getVatReport } from "@/application/vat-reports";
import { requireUserClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/empty-state";
import { PageLayout } from "@/components/app-shell";
import { PeriodNavigation } from "../../period-navigation";
import { formatDate, formatDateTime } from "@/lib/format-date";

export async function generateMetadata({
  params,
}: PageProps<"/companies/[companyId]/vat-reports/[period]/exports">): Promise<Metadata> {
  const { period } = await params;
  const t = await getTranslations("vatReports");
  return { title: t("exportHistoryTitle", { period }) };
}

export default async function ExportHistoryPage({
  params, searchParams,
}: PageProps<"/companies/[companyId]/vat-reports/[period]/exports">) {
  const { companyId, period } = await params;
  const search = await searchParams;
  const returnTo = safeCompanyReturnTo(companyId, search.returnTo);
  const client = await requireUserClient();
  const [company, report, artifacts, t, epo] = await Promise.all([
    getCompany(client, companyId),
    getVatReport(client, companyId, period),
    listVatReportArtifacts(client, { companyId, period }),
    getTranslations("vatReports"),
    getTranslations("epoExport"),
  ]);
  if (!company || !report) notFound();
  return (
    <PageLayout className="company-workspace vat-reports vat-output-page" measure="wide">
      <header className="company-page-header vat-report-header">
        <p>
          <CompanyReturnLink companyId={companyId} returnTo={returnTo} fallback={`/companies/${companyId}/vat`} />
        </p>
        <span className="vat-output-context">
          {company.name} · {period}
        </span>
        <h1>{t("exportHistoryTitle", { period })}</h1>
        <p>{t("exportHistoryDescription")}</p>
      </header>
      <PeriodNavigation
        returnTo={returnTo}
        active="exportHistory"
        companyId={companyId}
        period={period}
        reportAvailable
      />
      <section className="vat-export-history">
        {artifacts.length === 0 ? (
          <>
            <EmptyState icon="report" title={t("noExportArtifacts")} />
            <p>{t("noExportArtifactsHint")}</p>
          </>
        ) : (
          <div className="iv-table-wrap" role="region" aria-label={t("exportArtifacts")} tabIndex={0}>
            <table className="iv-table">
              <caption className="sr-only">{t("exportArtifacts")}</caption>
              <thead><tr>
                <th scope="col">{t("period")}</th>
                <th scope="col">{t("artifactForm")}</th>
                <th scope="col">{t("artifactCreatedAt")}</th>
                <th scope="col">{t("artifactAuthor")}</th>
                <th scope="col">{t("artifactActions")}</th>
              </tr></thead>
              <tbody>
                {artifacts.map((artifact) => {
                  const details = artifact.resolvedDetails;
                  const address = details.address
                    ? `${details.address.streetName} ${details.address.houseNumber}${details.address.orientationNumber ? `/${details.address.orientationNumber}` : ""}, ${details.address.postalCode} ${details.address.city}`
                    : epo("notSet");
                  const signatory = details.personType === "P"
                    ? `${details.signatoryFirstName} ${details.signatoryLastName} · ${details.signatoryCapacity}`
                    : epo("naturalPerson");
                  return <Fragment key={artifact.id}>
                    <tr>
                      <td>{artifact.period}</td>
                      <td>{epo(`formats.${artifact.format}`)}<br /><small>{t(`artifactKinds.${artifact.kind}`)}</small></td>
                      <td><time dateTime={artifact.createdAt}>{formatDateTime(artifact.createdAt)}</time></td>
                      <td>{artifact.authorEmail ?? artifact.authorUserId}</td>
                      <td><a
                        href={`/companies/${companyId}/vat-reports/${period}/artifacts/${artifact.id}`}
                        download={artifact.fileName}
                      >{artifact.fileName}</a></td>
                    </tr>
                    <tr>
                      <td colSpan={5}>
                        <details className="export-artifact-details">
                          <summary>{t("artifactFilingDetails")}</summary>
                          <dl>
                            <div><dt>{epo("taxOffice")}</dt><dd>{epo(`taxOffices.${details.taxOffice}`)}</dd></div>
                            <div><dt>{epo("territorialOffice")}</dt><dd>{details.territorialOffice || epo("notSet")}</dd></div>
                            {artifact.format === "dphdp3" && <div><dt>{epo("economicActivity")}</dt><dd>{details.economicActivity || epo("notSet")}</dd></div>}
                            <div><dt>{epo("preparedOn")}</dt><dd>{formatDate(details.preparedOn)}</dd></div>
                            <div><dt>{epo("signatory")}</dt><dd>{signatory}</dd></div>
                            <div><dt>{epo("email")}</dt><dd>{details.email || epo("notSet")}</dd></div>
                            <div><dt>{epo("phone")}</dt><dd>{details.phone || epo("notSet")}</dd></div>
                            <div><dt>{epo("serializedAddress")}</dt><dd>{address}</dd></div>
                            <div><dt>{t("artifactChecksum")}</dt><dd className="iv-mono">{artifact.sha256}</dd></div>
                          </dl>
                        </details>
                      </td>
                    </tr>
                  </Fragment>;
                })}
              </tbody>
            </table>
          </div>
        )}
        <div>
          <Link href={withCompanyReturnTo(companyId, `/companies/${companyId}/vat-reports/${period}/vat-return`, returnTo)}>
            {t("openVatReturn")}
          </Link>
          <Link href={withCompanyReturnTo(companyId, `/companies/${companyId}/vat-reports/${period}/control-statement`, returnTo)}>
            {t("openControlStatement")}
          </Link>
        </div>
      </section>
    </PageLayout>
  );
}
