import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  DOCUMENT_STATUSES,
  listCompanyDocuments,
  type DocumentStatus,
} from "@/application/documents";
import { getUploadBatch } from "@/application/upload-batches";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { statusBadgeState } from "@/components/status-badge-state";
import { requireUserClient } from "@/lib/supabase/server";

export default async function DocumentsPage({
  params,
  searchParams,
}: PageProps<"/companies/[companyId]/documents">) {
  const { companyId } = await params;
  const query = await searchParams;
  const statusParam = typeof query.status === "string" ? query.status : undefined;
  const batchId = typeof query.batchId === "string" ? query.batchId : undefined;
  const status = DOCUMENT_STATUSES.includes(statusParam as DocumentStatus)
    ? statusParam as DocumentStatus
    : undefined;
  const client = await requireUserClient();
  const batch = batchId
    ? await getUploadBatch(client, companyId, batchId)
    : null;
  const documents = await listCompanyDocuments(client, companyId, {
    status,
    sourceFileIds: batchId ? (batch?.sourceFiles.map((source) => source.id) ?? []) : undefined,
  });
  const t = await getTranslations();
  return <main className="company-workspace">
    <header className="company-page-header">
      <h1>{t("shell.documentsTitle")}</h1>
      <p>{batch ? t("uploadWorkspace.filteredQueue", { count: documents.length }) : t("shell.documentsDescription")}</p>
      {batch && <Link href={`/companies/${companyId}/upload-batches/${batch.id}`}>{t("uploadWorkspace.backToBatch")}</Link>}
    </header>
    {documents.length > 0 ? <DataTable
      caption={t("shell.documentsTitle")}
      rows={documents}
      columns={[
        {
          key: "document",
          header: t("uploadWorkspace.document"),
          render: (document) => <Link href={`/companies/${companyId}/documents/${document.id}`}>{document.documentNumber ?? t("uploadWorkspace.documentPages", { first: document.firstPage, last: document.lastPage })}</Link>,
        },
        {
          key: "status",
          header: t("uploadWorkspace.status"),
          render: (document) => <StatusBadge status={statusBadgeState(document.status, "document")}>{t(`documentStatus.${document.status}`)}</StatusBadge>,
        },
      ]}
    /> : <section className="company-workspace-empty"><span aria-hidden="true" /><p>{t("uploadWorkspace.noQueueDocuments")}</p></section>}
  </main>;
}
