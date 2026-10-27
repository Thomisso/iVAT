import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { getSourceFile } from "@/application/source-files";
import { AppHeader } from "@/components/app-header";
import { requireUserClient } from "@/lib/supabase/server";

export default async function SourceFilePage({ params }: PageProps<"/companies/[companyId]/source-files/[sourceFileId]">) {
  const { companyId, sourceFileId } = await params;
  const file = await getSourceFile(await requireUserClient(), companyId, sourceFileId);
  if (!file) notFound();
  const t = await getTranslations("sourceFiles");
  const format = await getFormatter();
  const contentUrl = `/companies/${companyId}/source-files/${file.id}/content`;

  return (
    <>
      <AppHeader currentCompanyId={companyId} />
      <main className="dashboard">
        <header>
          <p>
            <Link href={`/companies/${companyId}`}>{t("backToCompany")}</Link>
          </p>
          <h1>{file.fileName}</h1>
          <p className="muted">
            {file.format.toUpperCase()} · {t("pageCount", { count: file.pageCount })} ·{" "}
            {format.number(file.byteSize / 1000, { style: "unit", unit: "kilobyte", maximumFractionDigits: 1 })} ·{" "}
            {format.dateTime(new Date(file.uploadedAt), { dateStyle: "medium", timeStyle: "short" })}
          </p>
          <p className="muted">
            {t("hash")} <code>{file.sha256}</code>
          </p>
        </header>
        {file.format === "pdf" ? (
          <iframe className="source-file-viewer" src={contentUrl} title={file.fileName} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- the original is shown as stored, not optimized
          <img className="source-file-viewer" src={contentUrl} alt={file.fileName} />
        )}
      </main>
    </>
  );
}
