import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { getCompany } from "@/application/companies";
import { listVatReportArtifacts } from "@/application/epo-export";
import { getVatReport } from "@/application/vat-reports";
import { requireUserClient } from "@/lib/supabase/server";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PageLayout } from "@/components/app-shell";
import { PeriodNavigation } from "../../period-navigation";

export async function generateMetadata({
  params,
}: PageProps<"/companies/[companyId]/vat-reports/[period]/exports">): Promise<Metadata> {
  const { period } = await params;
  const t = await getTranslations("vatReports");
  return { title: t("exportHistoryTitle", { period }) };
}

export default async function ExportHistoryPage({
  params,
}: PageProps<"/companies/[companyId]/vat-reports/[period]/exports">) {
  const { companyId, period } = await params;
  const client = await requireUserClient();
  const [company, report, artifacts, t, epo, format] = await Promise.all([
    getCompany(client, companyId),
    getVatReport(client, companyId, period),
    listVatReportArtifacts(client, { companyId, period }),
    getTranslations("vatReports"),
    getTranslations("epoExport"),
    getFormatter(),
  ]);
  if (!company || !report) notFound();
  return (
    <PageLayout className="company-workspace vat-reports vat-output-page" measure="wide">
      <header className="company-page-header vat-report-header">
        <p>
          <Link href={`/companies/${companyId}/vat`}>
            {t("backToPeriods")}
          </Link>
        </p>
        <span className="vat-output-context">
          {company.name} · {period}
        </span>
        <h1>{t("exportHistoryTitle", { period })}</h1>
        <p>{t("exportHistoryDescription")}</p>
      </header>
      <PeriodNavigation
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
          <DataTable
            caption={t("exportArtifacts")}
            rows={artifacts}
            columns={[
              {
                key: "kind",
                header: t("artifactKind"),
                render: (artifact) => t(`artifactKinds.${artifact.kind}`),
              },
              {
                key: "format",
                header: t("artifactFormat"),
                render: (artifact) => artifact.format.toUpperCase(),
              },
              {
                key: "createdAt",
                header: t("artifactCreatedAt"),
                render: (artifact) => format.dateTime(new Date(artifact.createdAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              },
              {
                key: "authorEmail",
                header: t("artifactAuthor"),
                render: (artifact) => artifact.authorEmail ?? artifact.authorUserId,
              },
              {
                key: "resolvedDetails",
                header: t("artifactFilingDetails"),
                render: (artifact) => {
                  const details = artifact.resolvedDetails;
                  const address = details.address
                    ? `${details.address.streetName} ${details.address.houseNumber}${details.address.orientationNumber ? `/${details.address.orientationNumber}` : ""}, ${details.address.postalCode} ${details.address.city}`
                    : epo("notSet");
                  const signatory = details.personType === "P"
                    ? `${details.signatoryFirstName} ${details.signatoryLastName} · ${details.signatoryCapacity}`
                    : epo("naturalPerson");
                  return (
                    <dl className="epo-export-summary">
                      <div><dt>{epo("taxOffice")}</dt><dd>{details.taxOffice}</dd></div>
                      <div><dt>{epo("preparedOn")}</dt><dd>{details.preparedOn}</dd></div>
                      <div><dt>{epo("signatory")}</dt><dd>{signatory}</dd></div>
                      <div><dt>{epo("email")}</dt><dd>{details.email || epo("notSet")}</dd></div>
                      <div><dt>{epo("phone")}</dt><dd>{details.phone || epo("notSet")}</dd></div>
                      <div><dt>{epo("serializedAddress")}</dt><dd>{address}</dd></div>
                    </dl>
                  );
                },
              },
              {
                key: "sha256",
                header: "SHA-256",
                mono: true,
                render: (artifact) => artifact.sha256.slice(0, 12),
              },
              {
                key: "download",
                header: t("artifactDownload"),
                render: (artifact) => (
                  <a
                    href={`/companies/${companyId}/vat-reports/${period}/artifacts/${artifact.id}`}
                    download={artifact.fileName}
                  >
                    {artifact.fileName}
                  </a>
                ),
              },
            ]}
          />
        )}
        <div>
          <Link href={`/companies/${companyId}/vat-reports/${period}/vat-return`}>
            {t("openVatReturn")}
          </Link>
          <Link href={`/companies/${companyId}/vat-reports/${period}/control-statement`}>
            {t("openControlStatement")}
          </Link>
        </div>
      </section>
    </PageLayout>
  );
}
