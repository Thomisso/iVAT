import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getPlatformCompanyHistory } from "@/application/platform-company-history";
import { PageContent, PageHeader, PageLayout } from "@/components/app-shell";
import { DataTable } from "@/components/data-table";
import { Notice } from "@/components/notice";
import { Money } from "@/components/money";
import { formatDate, formatDateTime } from "@/lib/format-date";
import { requireUserClient } from "@/lib/supabase/server";

export default async function PlatformCompanyHistoryPage({ params }: PageProps<"/platform/companies/[companyId]/history">) {
  const { companyId } = await params;
  const [history, t] = await Promise.all([
    getPlatformCompanyHistory(await requireUserClient(), companyId), getTranslations("platformHistory"),
  ]);
  if (!history.ok) notFound();
  const { snapshot, deletedAt, blocked, organizationName, auditEvents } = history.value;
  const { company } = snapshot;
  const base = `/platform/companies/${company.id}/history`;
  return <PageLayout measure="wide">
    <PageHeader title={t("title", { company: company.name })} description={organizationName} />
    <PageContent measure="wide">
      <Notice tone={deletedAt || blocked ? "warning" : "info"}>
        {deletedAt ? t("deletedNotice", { date: formatDateTime(deletedAt) })
          : blocked ? t("blockedNotice") : t("readOnlyNotice")}
      </Notice>
      <p>
        <Link href={`/organizations/${company.organizationId}/members`}>{t("organizationAdministration")}</Link>
        {" · "}<Link href={`/organizations/${company.organizationId}/audit-log?companyId=${company.id}`}>{t("organizationAudit")}</Link>
        {" · "}<a href={`${base}/archive`}>{t("downloadArchive")}</a>
        {!deletedAt && <>{" · "}<Link href={`/platform/companies/${company.id}/members`}>{t("companyAdministration")}</Link></>}
      </p>
      <section className="panel">
        <h2>{t("companyIdentity")}</h2>
        <p>{t("identityLine", { name: company.name, ico: company.ico, vatId: company.vatId })}</p>
        <p>{company.street}, {company.postalCode} {company.city}</p>
      </section>
      <section className="panel">
        <h2>{t("sourceFiles")}</h2>
        <DataTable caption={t("sourceFiles")} rows={snapshot.sourceFiles} columns={[
          { key: "fileName", header: t("file"), render: (file) => <a href={`${base}/source-files/${file.id}`}>{file.fileName}</a> },
          { key: "uploadedAt", header: t("uploadedAt"), render: (file) => formatDateTime(file.uploadedAt) },
          { key: "byteSize", header: t("byteSize"), align: "right" },
        ]} />
      </section>
      <section className="panel">
        <h2>{t("documents")}</h2>
        {snapshot.documents.map((document) => <article key={document.id}>
          <h3>{snapshot.sourceFiles.find((file) => file.id === document.sourceFileId)?.fileName ?? t("document")}
            {" · "}{t("pages", { first: document.firstPage, last: document.lastPage })}</h3>
          {document.extractionVersions.map((version) => <details key={version.id}>
            <summary>{t("version", { version: version.version, date: formatDateTime(version.createdAt) })}</summary>
            <dl>
              <dt>{t("documentNumber")}</dt><dd>{version.payload.documentNumber ?? t("notAvailable")}</dd>
              <dt>{t("supplier")}</dt><dd>{version.payload.supplier.name ?? t("notAvailable")}</dd>
              <dt>{t("customer")}</dt><dd>{version.payload.customer.name ?? t("notAvailable")}</dd>
              <dt>{t("taxPointDate")}</dt><dd>{version.payload.taxPointDate ? formatDate(version.payload.taxPointDate) : t("notAvailable")}</dd>
              <dt>{t("total")}</dt><dd>{version.payload.totals.grossAmount === null ? t("notAvailable")
                : <Money amount={Number(version.payload.totals.grossAmount)} currency={version.payload.currency ?? ""} />}</dd>
            </dl>
          </details>)}
        </article>)}
        {snapshot.documents.length === 0 && <p>{t("noDocuments")}</p>}
      </section>
      <section className="panel">
        <h2>{t("vatReports")}</h2>
        <DataTable caption={t("vatReports")} rows={snapshot.vatReports} columns={[
          { key: "period", header: t("period") },
          { key: "generatedAt", header: t("generatedAt"), render: (report) => formatDateTime(report.generatedAt) },
        ]} />
        <h3>{t("xmlArtifacts")}</h3>
        <ul>{snapshot.vatReportArtifacts.map((artifact) => <li key={artifact.id}>
          <a href={`${base}/artifacts/${artifact.id}`}>{artifact.fileName}</a>{" · "}{formatDateTime(artifact.createdAt)}
        </li>)}</ul>
      </section>
      <section className="panel">
        <h2>{t("audit")}</h2>
        <DataTable caption={t("audit")} rows={auditEvents} columns={[
          { key: "occurredAt", header: t("occurredAt"), render: (event) => formatDateTime(event.occurredAt) },
          { key: "action", header: t("action") },
          { key: "actorUserId", header: t("actor"), mono: true },
        ]} />
      </section>
    </PageContent>
  </PageLayout>;
}
