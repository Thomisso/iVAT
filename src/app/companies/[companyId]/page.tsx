import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { getCompany } from "@/application/companies";
import { listSourceFiles } from "@/application/source-files";
import { disableAiProcessingAction, enableAiProcessingAction } from "@/app/actions";
import { configuredAiProvider } from "@/ai";
import { AppHeader } from "@/components/app-header";
import { CommandButton } from "@/components/command-button";
import { RefreshWhile } from "@/components/refresh-while";
import { requireUserClient } from "@/lib/supabase/server";
import { SourceFileUploadForm } from "./source-file-upload-form";

export default async function CompanyDashboardPage({ params }: PageProps<"/companies/[companyId]">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const company = await getCompany(client, companyId);
  if (!company) notFound();
  const sourceFiles = await listSourceFiles(client, company.id);
  const t = await getTranslations();
  const format = await getFormatter();
  const provider = configuredAiProvider();
  const processing = sourceFiles.some((file) => file.status === "uploaded" || file.status === "processing");

  return (
    <>
      <AppHeader currentCompanyId={company.id} />
      <main className="dashboard">
        <header>
          <h1>{company.name}</h1>
          <p className="muted">
            {t("company.ico")} {company.ico} · {t("company.vatId")} {company.vatId} · {company.street},{" "}
            {company.postalCode} {company.city}
          </p>
        </header>
        <section className="ai-processing">
          <h2>{t("aiProcessing.title")}</h2>
          {company.aiProcessing ? (
            <>
              <p>{t("aiProcessing.on", company.aiProcessing)}</p>
              <CommandButton action={disableAiProcessingAction} fields={{ companyId: company.id }}>
                {t("aiProcessing.disable")}
              </CommandButton>
            </>
          ) : (
            <>
              <p>{t("aiProcessing.off")}</p>
              <p className="muted">{t("aiProcessing.consent", { provider: provider.name, region: provider.region })}</p>
              <CommandButton action={enableAiProcessingAction} fields={{ companyId: company.id }}>
                {t("aiProcessing.enable")}
              </CommandButton>
            </>
          )}
        </section>
        <section>
          <h2>{t("sourceFiles.title")}</h2>
          <SourceFileUploadForm companyId={company.id} />
          {sourceFiles.length === 0 ? (
            <p className="empty">{t("sourceFiles.none")}</p>
          ) : (
            <table className="source-files">
              <thead>
                <tr>
                  <th>{t("sourceFiles.fileName")}</th>
                  <th>{t("sourceFiles.format")}</th>
                  <th>{t("sourceFiles.pages")}</th>
                  <th>{t("sourceFiles.uploadedAt")}</th>
                  <th>{t("sourceFiles.status")}</th>
                </tr>
              </thead>
              <tbody>
                {sourceFiles.map((file) => (
                  <tr key={file.id}>
                    <td>
                      <Link href={`/companies/${company.id}/source-files/${file.id}`}>{file.fileName}</Link>
                    </td>
                    <td>{file.format.toUpperCase()}</td>
                    <td>{file.pageCount}</td>
                    <td>{format.dateTime(new Date(file.uploadedAt), { dateStyle: "medium", timeStyle: "short" })}</td>
                    <td>{t(`sourceFileStatus.${file.status}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
      <RefreshWhile active={processing && company.aiProcessing !== null} />
    </>
  );
}
