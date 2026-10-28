import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import { getUploadLimits } from "@/application/source-files";
import { listUploadBatches } from "@/application/upload-batches";
import { requireUserClient } from "@/lib/supabase/server";
import { SourceFileUploadForm } from "../source-file-upload-form";

const HISTORY_PAGE_SIZE = 20;

export default async function UploadPage({
  params,
  searchParams,
}: PageProps<"/companies/[companyId]/upload">) {
  const { companyId } = await params;
  const query = await searchParams;
  const requestedPage = Number(typeof query.historyPage === "string" ? query.historyPage : "1");
  const historyPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const client = await requireUserClient();
  const [company, role, limits, batches, t, ai, workspace, format] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    getUploadLimits(client),
    listUploadBatches(client, companyId, {
      limit: HISTORY_PAGE_SIZE + 1,
      offset: (historyPage - 1) * HISTORY_PAGE_SIZE,
    }),
    getTranslations("shell"),
    getTranslations("aiProcessing"),
    getTranslations("uploadWorkspace"),
    getFormatter(),
  ]);
  if (!company) notFound();
  const hasNextPage = batches.length > HISTORY_PAGE_SIZE;
  const visibleBatches = batches.slice(0, HISTORY_PAGE_SIZE);
  return <main className="company-workspace">
    <header className="company-page-header"><h1>{t("uploadTitle")}</h1><p>{t("uploadDescription")}</p></header>
    {!company.aiProcessing && <section className="panel" role="status">
      <h2>{ai("waitingTitle")}</h2>
      <p>{ai("waitingReason")}</p>
      {role === "administrator" && <Link href={`/companies/${companyId}/settings`}>{ai("configureAction")}</Link>}
    </section>}
    <section className="panel upload-workspace-new" aria-labelledby="new-upload-title">
      <div><h2 id="new-upload-title">{workspace("newBatch")}</h2><p>{workspace("newBatchHint")}</p></div>
      <SourceFileUploadForm companyId={companyId} limits={limits} />
    </section>
    <section className="upload-history" aria-labelledby="upload-history-title">
      <div className="upload-section-heading"><div><h2 id="upload-history-title">{workspace("history")}</h2><p>{workspace("historyHint")}</p></div><span>{workspace("historyPage", { page: historyPage })}</span></div>
      {visibleBatches.length ? <ol className="upload-batch-list">
        {visibleBatches.map((batch) => <li key={batch.id}>
          <Link href={`/companies/${companyId}/upload-batches/${batch.id}`}>
            <span className={`upload-outcome upload-outcome-${batch.outcome}`}>{workspace(`outcome.${batch.outcome}`)}</span>
            <strong>{workspace("batchFiles", { count: batch.actualFileCount, planned: batch.plannedFileCount })}</strong>
            <span>{format.dateTime(new Date(batch.createdAt), { dateStyle: "medium", timeStyle: "short" })}</span>
            <span>{workspace("batchSummary", {
              waiting: batch.counts.waiting + batch.counts.splitting + batch.counts.extracting,
              review: batch.counts.review,
              failures: batch.counts.failures,
            })}</span>
          </Link>
        </li>)}
      </ol> : <div className="company-workspace-empty"><span aria-hidden="true" /><p>{workspace("noBatches")}</p></div>}
      {(historyPage > 1 || hasNextPage) && <nav className="upload-history-pagination" aria-label={workspace("historyPagination")}>
        {historyPage > 1
          ? <Link href={`/companies/${companyId}/upload?historyPage=${historyPage - 1}`}>{workspace("newerBatches")}</Link>
          : <span />}
        {hasNextPage && <Link href={`/companies/${companyId}/upload?historyPage=${historyPage + 1}`}>{workspace("olderBatches")}</Link>}
      </nav>}
    </section>
  </main>;
}
