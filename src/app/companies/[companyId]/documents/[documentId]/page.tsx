import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { approveDocumentAction, rejectDocumentAction } from "@/app/actions";
import { getCompany } from "@/application/companies";
import { getDocument, listExtractionVersions } from "@/application/documents";
import { getSourceFile } from "@/application/source-files";
import { AppHeader } from "@/components/app-header";
import { CommandButton } from "@/components/command-button";
import { RefreshWhile } from "@/components/refresh-while";
import { requireUserClient } from "@/lib/supabase/server";
import { CorrectionForm } from "./correction-form";

// The review workspace: the Document's original pages next to its extracted
// data. `?version=N` shows an earlier Extraction Version read-only.
export default async function DocumentReviewPage({
  params,
  searchParams,
}: PageProps<"/companies/[companyId]/documents/[documentId]">) {
  const { companyId, documentId } = await params;
  const { version: requestedVersion } = await searchParams;
  const client = await requireUserClient();
  const [company, document, versions, { data: auth }] = await Promise.all([
    getCompany(client, companyId),
    getDocument(client, companyId, documentId),
    listExtractionVersions(client, companyId, documentId),
    client.auth.getUser(),
  ]);
  if (!company || !document) notFound();
  const file = await getSourceFile(client, companyId, document.sourceFileId);
  if (!file) notFound();
  const t = await getTranslations();
  const format = await getFormatter();

  const current = versions.at(-1);
  const shown = versions.find((v) => String(v.version) === requestedVersion) ?? current;
  const reviewing = document.status === "needs_review" && current !== undefined;
  const contentUrl = `/companies/${companyId}/documents/${document.id}/content`;
  const pages =
    document.firstPage === document.lastPage
      ? t("review.page", { page: document.firstPage })
      : t("review.pageRange", { first: document.firstPage, last: document.lastPage });

  return (
    <>
      <AppHeader currentCompanyId={companyId} />
      <main className="review">
        <header className="review-header">
          <p>
            <Link href={`/companies/${companyId}`}>{t("review.backToCompany")}</Link>
          </p>
          <h1>
            {t("review.title")}
            {current?.payload.documentNumber && ` ${current.payload.documentNumber}`}
          </h1>
          <p className="muted">
            <Link href={`/companies/${companyId}/source-files/${file.id}`}>
              {t("review.sourceFile", { fileName: file.fileName, pages })}
            </Link>
          </p>
          <p>
            {t("review.status")}: <strong>{t(`documentStatus.${document.status}`)}</strong>
          </p>
          {document.status === "approved" && <p className="note">{t("review.approvedNote")}</p>}
          {document.status === "rejected" && <p className="note">{t("review.rejectedNote")}</p>}
          {!current && <p className="note">{t("review.notReviewableNote")}</p>}
        </header>
        <section className="review-original">
          {file.format === "pdf" ? (
            <iframe className="source-file-viewer" src={contentUrl} title={file.fileName} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- the original is shown as stored, not optimized
            <img className="source-file-viewer" src={contentUrl} alt={file.fileName} />
          )}
        </section>
        <section className="review-data">
          {shown && current && shown !== current && (
            <p className="note">
              {t("review.viewingOld", { version: shown.version, current: current.version })}{" "}
              <Link href={`/companies/${companyId}/documents/${document.id}`}>{t("review.showCurrent")}</Link>
            </p>
          )}
          {shown ? (
            <CorrectionForm
              key={shown.id}
              companyId={companyId}
              documentId={document.id}
              version={shown.version}
              payload={shown.payload}
              editable={reviewing && shown === current}
            />
          ) : (
            <p className="empty">{t("review.noExtraction")}</p>
          )}
          {reviewing && (
            <div className="review-decision">
              <CommandButton
                action={approveDocumentAction}
                fields={{ companyId, documentId: document.id, version: String(current.version) }}
              >
                {t("review.approve", { version: current.version })}
              </CommandButton>
              <CommandButton action={rejectDocumentAction} fields={{ companyId, documentId: document.id }}>
                {t("review.reject")}
              </CommandButton>
            </div>
          )}
          {versions.length > 0 && (
            <>
              <h2>{t("review.history")}</h2>
              <ol className="version-history" reversed>
                {versions.toReversed().map((v) => (
                  <li key={v.id} aria-current={v === shown ? "true" : undefined}>
                    <Link href={`/companies/${companyId}/documents/${document.id}?version=${v.version}`}>
                      {t("documents.version", {
                        version: v.version,
                        documentNumber: v.payload.documentNumber ?? "—",
                        author:
                          v.author.kind === "ai"
                            ? t("review.aiAuthor", { provider: v.author.provider, model: v.author.model })
                            : v.author.userId === auth.user?.id
                              ? `${t("review.userAuthor")} (${t("review.you")})`
                              : t("review.userAuthor"),
                      })}
                    </Link>{" "}
                    <span className="muted">
                      {format.dateTime(new Date(v.createdAt), { dateStyle: "medium", timeStyle: "short" })}
                      {v === current && ` · ${t("review.current")}`}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </main>
      <RefreshWhile
        active={company.aiProcessing !== null && (document.status === "uploaded" || document.status === "processing")}
      />
    </>
  );
}
