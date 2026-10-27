import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { reprocessDocumentAction, retrySplitAction } from "@/app/actions";
import { getCompany } from "@/application/companies";
import { listDocuments, listExtractionVersions } from "@/application/documents";
import { getSourceFile } from "@/application/source-files";
import { AppHeader } from "@/components/app-header";
import { CommandButton } from "@/components/command-button";
import { RefreshWhile } from "@/components/refresh-while";
import { requireUserClient } from "@/lib/supabase/server";

export default async function SourceFilePage({ params }: PageProps<"/companies/[companyId]/source-files/[sourceFileId]">) {
  const { companyId, sourceFileId } = await params;
  const client = await requireUserClient();
  const [company, file] = await Promise.all([getCompany(client, companyId), getSourceFile(client, companyId, sourceFileId)]);
  if (!company || !file) notFound();
  const documents = await Promise.all(
    (await listDocuments(client, companyId, file.id)).map(async (document) => ({
      ...document,
      current: (await listExtractionVersions(client, companyId, document.id)).at(-1),
    })),
  );
  const t = await getTranslations();
  const format = await getFormatter();
  const contentUrl = `/companies/${companyId}/source-files/${file.id}/content`;
  // Nothing moves until the Company enables AI processing.
  const processing =
    company.aiProcessing !== null &&
    (file.status === "uploaded" ||
    file.status === "processing" ||
    documents.some((d) => d.status === "uploaded" || d.status === "processing"));

  return (
    <>
      <AppHeader currentCompanyId={companyId} />
      <main className="dashboard">
        <header>
          <p>
            <Link href={`/companies/${companyId}`}>{t("sourceFiles.backToCompany")}</Link>
          </p>
          <h1>{file.fileName}</h1>
          <p className="muted">
            {file.format.toUpperCase()} · {t("sourceFiles.pageCount", { count: file.pageCount })} ·{" "}
            {format.number(file.byteSize / 1000, { style: "unit", unit: "kilobyte", maximumFractionDigits: 1 })} ·{" "}
            {format.dateTime(new Date(file.uploadedAt), { dateStyle: "medium", timeStyle: "short" })}
          </p>
          <p className="muted">
            {t("sourceFiles.hash")} <code>{file.sha256}</code>
          </p>
        </header>
        <section>
          <h2>{t("documents.title")}</h2>
          <p>
            {t("sourceFiles.status")}: {t(`sourceFileStatus.${file.status}`)}
            {!company.aiProcessing && <span className="muted"> · {t("aiProcessing.waiting")}</span>}
          </p>
          {file.status === "failed" && (
            <CommandButton action={retrySplitAction} fields={{ companyId, sourceFileId: file.id }}>
              {t("documents.retrySplit")}
            </CommandButton>
          )}
          {documents.length > 0 && (
            <table className="source-files">
              <thead>
                <tr>
                  <th>{t("documents.pages")}</th>
                  <th>{t("documents.status")}</th>
                  <th>{t("documents.extraction")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id}>
                    <td>
                      {document.firstPage === document.lastPage
                        ? document.firstPage
                        : `${document.firstPage}–${document.lastPage}`}
                    </td>
                    <td>{t(`documentStatus.${document.status}`)}</td>
                    <td>
                      {document.current &&
                        t("documents.version", {
                          version: document.current.version,
                          documentNumber: document.current.payload.documentNumber ?? "—",
                          author:
                            document.current.author.kind === "ai"
                              ? `${document.current.author.provider} / ${document.current.author.model}`
                              : t("documents.userAuthor"),
                        })}
                    </td>
                    <td>
                      {(document.status === "failed" || document.status === "needs_review") && (
                        <CommandButton action={reprocessDocumentAction} fields={{ companyId, documentId: document.id }}>
                          {document.status === "failed" ? t("documents.retry") : t("documents.reprocess")}
                        </CommandButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        {file.format === "pdf" ? (
          <iframe className="source-file-viewer" src={contentUrl} title={file.fileName} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- the original is shown as stored, not optimized
          <img className="source-file-viewer" src={contentUrl} alt={file.fileName} />
        )}
      </main>
      <RefreshWhile active={processing} />
    </>
  );
}
