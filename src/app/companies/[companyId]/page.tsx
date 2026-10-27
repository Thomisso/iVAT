import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { getCompany } from "@/application/companies";
import {
  DOCUMENT_STATUSES,
  isBeingExtracted,
  listCompanyDocuments,
  type DocumentFilters,
} from "@/application/documents";
import { DIRECTIONS } from "@/application/extraction-payload";
import { listSourceFiles } from "@/application/source-files";
import {
  disableAiProcessingAction,
  enableAiProcessingAction,
} from "@/app/actions";
import { configuredAiProvider } from "@/ai";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandButton } from "@/components/command-button";
import { RefreshWhile } from "@/components/refresh-while";
import { requireUserClient } from "@/lib/supabase/server";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Money } from "@/components/money";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { StatusBadge } from "@/components/status-badge";
import { statusBadgeState } from "@/components/status-badge-state";
import { formatDocumentDate } from "@/lib/format-date";
import { SourceFileUploadForm } from "./source-file-upload-form";

/** The Document list filters a query string names; unknown values are ignored. */
function documentFilters(
  query: Record<string, string | string[] | undefined>,
): DocumentFilters {
  const one = (name: string) =>
    typeof query[name] === "string" ? query[name] : undefined;
  const status = DOCUMENT_STATUSES.find((s) => s === one("status"));
  const direction = DIRECTIONS.find((d) => d === one("direction"));
  const reportingPeriod = /^\d{4}-(0[1-9]|1[0-2])$/.test(one("period") ?? "")
    ? one("period")
    : undefined;
  const counterparty = one("counterparty")?.trim() || undefined;
  return { status, direction, reportingPeriod, counterparty };
}

export default async function CompanyDashboardPage({
  params,
  searchParams,
}: PageProps<"/companies/[companyId]">) {
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
  const provider = configuredAiProvider();
  const processing =
    sourceFiles.some(
      (file) => file.status === "uploaded" || file.status === "processing",
    ) ||
    documents.some((document) => isBeingExtracted(document.status));

  return (
    <>
      <AppSidebar
        currentCompanyId={company.id}
        activeDirection={filters.direction}
      />
      <main className="dashboard">
        <header>
          <h1>{company.name}</h1>
          <p className="iv-muted">
            {t("company.ico")} <span className="iv-mono">{company.ico}</span> ·{" "}
            {t("company.vatId")}{" "}
            <span className="iv-mono">{company.vatId}</span> · {company.street},{" "}
            {company.postalCode} {company.city}
          </p>
        </header>
        <section className="ai-processing">
          <h2>{t("aiProcessing.title")}</h2>
          {company.aiProcessing ? (
            <>
              <p>{t("aiProcessing.on", company.aiProcessing)}</p>
              <CommandButton
                action={disableAiProcessingAction}
                fields={{ companyId: company.id }}
              >
                {t("aiProcessing.disable")}
              </CommandButton>
            </>
          ) : (
            <>
              <p>{t("aiProcessing.off")}</p>
              <p className="iv-muted">
                {t("aiProcessing.consent", {
                  provider: provider.name,
                  region: provider.region,
                })}
              </p>
              <CommandButton
                variant="ai"
                icon="marker"
                action={enableAiProcessingAction}
                fields={{ companyId: company.id }}
              >
                {t("aiProcessing.enable")}
              </CommandButton>
            </>
          )}
        </section>
        <section className="documents">
          <h2>{t("documents.title")}</h2>
          <form className="form filters" aria-label={t("documents.filters")}>
            <label className="iv-field-label">
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
            <label className="iv-field-label">
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
            <TextField
              label={t("documents.reportingPeriod")}
              type="month"
              name="period"
              defaultValue={filters.reportingPeriod ?? ""}
            />
            <TextField
              label={t("documents.counterparty")}
              type="search"
              name="counterparty"
              defaultValue={filters.counterparty ?? ""}
              placeholder={t("documents.counterpartyHint")}
            />
            <Button type="submit">{t("documents.filter")}</Button>
            {filtered && (
              <Link href={`/companies/${company.id}`}>
                {t("documents.clearFilters")}
              </Link>
            )}
          </form>
          {documents.length === 0 ? (
            <EmptyState
              icon="inbox"
              title={filtered ? t("documents.noMatch") : t("documents.none")}
            />
          ) : (
            <DataTable
              caption={t("documents.title")}
              rows={documents}
              columns={[
                {
                  key: "documentNumber",
                  header: t("documents.documentNumber"),
                  mono: true,
                  render: (document) => (
                    <Link
                      href={`/companies/${company.id}/documents/${document.id}`}
                    >
                      {document.documentNumber ?? t("documents.review")}
                    </Link>
                  ),
                },
                {
                  key: "counterparty",
                  header: t("documents.counterparty"),
                  render: (document) => (
                    <>
                      {document.counterparty?.name ?? t("review.notSet")}
                      {document.counterparty?.vatId && (
                        <span className="iv-muted iv-mono">
                          {" "}
                          · {document.counterparty.vatId}
                        </span>
                      )}
                    </>
                  ),
                },
                {
                  key: "direction",
                  header: t("documents.direction"),
                  render: (document) =>
                    document.direction
                      ? t(`review.direction.${document.direction}`)
                      : t("review.notSet"),
                },
                {
                  key: "taxPointDate",
                  header: t("documents.taxPointDate"),
                  muted: true,
                  render: (document) =>
                    document.taxPointDate
                      ? formatDocumentDate(document.taxPointDate)
                      : t("review.notSet"),
                },
                {
                  key: "reportingPeriod",
                  header: t("documents.reportingPeriod"),
                  mono: true,
                },
                {
                  key: "eligibleForVatReport",
                  header: t("documents.vatReport"),
                  render: (document) =>
                    document.eligibleForVatReport
                      ? t("documents.eligible")
                      : t("documents.notEligible"),
                },
                {
                  key: "status",
                  header: t("documents.status"),
                  render: (document) => (
                    <StatusBadge
                      status={statusBadgeState(document.status, "document")}
                    >
                      {t(`documentStatus.${document.status}`)}
                    </StatusBadge>
                  ),
                },
                {
                  key: "grossAmount",
                  header: t("documents.grossAmount"),
                  align: "right",
                  render: (document) =>
                    document.grossAmount !== null ? (
                      <Money
                        amount={Number(document.grossAmount)}
                        currency={document.currency ?? ""}
                      />
                    ) : (
                      t("review.notSet")
                    ),
                },
              ]}
            />
          )}
        </section>
        <section>
          <h2>{t("sourceFiles.title")}</h2>
          <SourceFileUploadForm companyId={company.id} />
          {sourceFiles.length === 0 ? (
            <EmptyState icon="file" title={t("sourceFiles.none")} />
          ) : (
            <DataTable
              caption={t("sourceFiles.title")}
              rows={sourceFiles}
              columns={[
                {
                  key: "fileName",
                  header: t("sourceFiles.fileName"),
                  render: (file) => (
                    <Link
                      href={`/companies/${company.id}/source-files/${file.id}`}
                    >
                      {file.fileName}
                    </Link>
                  ),
                },
                {
                  key: "format",
                  header: t("sourceFiles.format"),
                  render: (file) => file.format.toUpperCase(),
                },
                {
                  key: "pageCount",
                  header: t("sourceFiles.pages"),
                  mono: true,
                  align: "right",
                },
                {
                  key: "uploadedAt",
                  header: t("sourceFiles.uploadedAt"),
                  muted: true,
                  render: (file) => formatDocumentDate(file.uploadedAt, true),
                },
                {
                  key: "status",
                  header: t("sourceFiles.status"),
                  render: (file) => (
                    <StatusBadge
                      status={statusBadgeState(file.status, "source-file")}
                    >
                      {t(`sourceFileStatus.${file.status}`)}
                    </StatusBadge>
                  ),
                },
              ]}
            />
          )}
        </section>
      </main>
      <RefreshWhile active={processing && company.aiProcessing !== null} />
    </>
  );
}
