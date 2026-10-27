import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { getCompany } from "@/application/companies";
import { listCompanyDocuments, type DocumentFilters, type DocumentStatus } from "@/application/documents";
import { DIRECTIONS } from "@/application/extraction-payload";
import { listSourceFiles } from "@/application/source-files";
import { disableAiProcessingAction, enableAiProcessingAction } from "@/app/actions";
import { configuredAiProvider } from "@/ai";
import { AppHeader } from "@/components/app-header";
import { CommandButton } from "@/components/command-button";
import { RefreshWhile } from "@/components/refresh-while";
import { requireUserClient } from "@/lib/supabase/server";
import { SourceFileUploadForm } from "./source-file-upload-form";

const DOCUMENT_STATUSES: DocumentStatus[] = ["uploaded", "processing", "needs_review", "approved", "rejected", "failed"];

/** The Document list filters a query string names; unknown values are ignored. */
function documentFilters(query: Record<string, string | string[] | undefined>): DocumentFilters {
  const one = (name: string) => (typeof query[name] === "string" ? query[name] : undefined);
  const status = DOCUMENT_STATUSES.find((s) => s === one("status"));
  const direction = DIRECTIONS.find((d) => d === one("direction"));
  const reportingPeriod = /^\d{4}-(0[1-9]|1[0-2])$/.test(one("period") ?? "") ? one("period") : undefined;
  const counterparty = one("counterparty")?.trim() || undefined;
  return { status, direction, reportingPeriod, counterparty };
}

export default async function CompanyDashboardPage({ params, searchParams }: PageProps<"/companies/[companyId]">) {
  const { companyId } = await params;
  const filters = documentFilters(await searchParams);
  const filtered = Object.values(filters).some((value) => value !== undefined);
  const client = await requireUserClient();
  const company = await getCompany(client, companyId);
  if (!company) notFound();
  const [sourceFiles, documents] = await Promise.all([
    listSourceFiles(client, company.id),
    listCompanyDocuments(client, company.id, filters),
  ]);
  const t = await getTranslations();
  const format = await getFormatter();
  const provider = configuredAiProvider();
  const processing =
    sourceFiles.some((file) => file.status === "uploaded" || file.status === "processing") ||
    documents.some((document) => document.status === "uploaded" || document.status === "processing");

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
        <section className="documents">
          <h2>{t("documents.title")}</h2>
          <form className="form filters" aria-label={t("documents.filters")}>
            <label>
              {t("documents.status")}
              <select name="status" defaultValue={filters.status ?? ""}>
                <option value="">{t("documents.allStatuses")}</option>
                {DOCUMENT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {t(`documentStatus.${status}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("documents.direction")}
              <select name="direction" defaultValue={filters.direction ?? ""}>
                <option value="">{t("documents.allDirections")}</option>
                {DIRECTIONS.map((direction) => (
                  <option key={direction} value={direction}>
                    {t(`review.direction.${direction}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("documents.reportingPeriod")}
              <input type="month" name="period" defaultValue={filters.reportingPeriod ?? ""} />
            </label>
            <label>
              {t("documents.counterparty")}
              <input
                type="search"
                name="counterparty"
                defaultValue={filters.counterparty ?? ""}
                placeholder={t("documents.counterpartyHint")}
              />
            </label>
            <button type="submit">{t("documents.filter")}</button>
            {filtered && <Link href={`/companies/${company.id}`}>{t("documents.clearFilters")}</Link>}
          </form>
          {documents.length === 0 ? (
            <p className="empty">{filtered ? t("documents.noMatch") : t("documents.none")}</p>
          ) : (
            <table className="source-files">
              <thead>
                <tr>
                  <th>{t("documents.documentNumber")}</th>
                  <th>{t("documents.counterparty")}</th>
                  <th>{t("documents.direction")}</th>
                  <th>{t("documents.taxPointDate")}</th>
                  <th>{t("documents.reportingPeriod")}</th>
                  <th className="amount">{t("documents.grossAmount")}</th>
                  <th>{t("documents.status")}</th>
                  <th>{t("documents.vatReport")}</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id}>
                    <td>
                      <Link href={`/companies/${company.id}/documents/${document.id}`}>
                        {document.documentNumber ?? t("documents.review")}
                      </Link>
                    </td>
                    <td>
                      {document.counterparty?.name ?? "—"}
                      {document.counterparty?.vatId && <span className="muted"> · {document.counterparty.vatId}</span>}
                    </td>
                    <td>{document.direction ? t(`review.direction.${document.direction}`) : "—"}</td>
                    <td>{document.taxPointDate ? format.dateTime(new Date(document.taxPointDate), { dateStyle: "medium", timeZone: "UTC" }) : "—"}</td>
                    <td>{document.reportingPeriod ?? "—"}</td>
                    <td className="amount">
                      {document.grossAmount ? `${document.grossAmount} ${document.currency ?? ""}` : "—"}
                    </td>
                    <td>{t(`documentStatus.${document.status}`)}</td>
                    <td>{document.eligibleForVatReport ? t("documents.eligible") : t("documents.notEligible")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
