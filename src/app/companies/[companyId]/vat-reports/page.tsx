import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getCompany } from "@/application/companies";
import { getVatReport } from "@/application/vat-reports";
import { vatReturnPreviewData } from "@/application/vat-return-preview";
import { isReportingPeriod } from "@/application/vat-rules";
import { requireUserClient } from "@/lib/supabase/server";
import { AppSidebar } from "@/components/app-sidebar";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Money } from "@/components/money";
import { TextField } from "@/components/text-field";
import { Button } from "@/components/button";
import { formatDocumentDate } from "@/lib/format-date";
import { GenerateForm } from "./generate-form";
import { ExportForm } from "./export-form";

export default async function VatReportsPage({
  params,
  searchParams,
}: PageProps<"/companies/[companyId]/vat-reports">) {
  const { companyId } = await params;
  const query = await searchParams;
  const period =
    typeof query.period === "string" && isReportingPeriod(query.period)
      ? query.period
      : new Date().toISOString().slice(0, 7);
  const client = await requireUserClient();
  const company = await getCompany(client, companyId);
  if (!company) notFound();
  const [report, t, locale] = await Promise.all([
    getVatReport(client, companyId, period),
    getTranslations(),
    getLocale(),
  ]);
  const documents = report?.documents ?? [];
  const documentLink = (id: string) => (
    <Link href={`/companies/${companyId}/documents/${id}`}>
      {documents.find((d) => d.id === id)?.payload?.documentNumber ??
        t("documents.review")}
    </Link>
  );
  const drilldown = (amount: string, ids: string[]) =>
    ids.length ? (
      <details className="report-drilldown">
        <summary>
          <Money amount={Number(amount)} currency="CZK" locale={locale} />
        </summary>
        <ul aria-label={t("vatReports.contributors")}>
          {ids.map((id) => (
            <li key={id}>{documentLink(id)}</li>
          ))}
        </ul>
      </details>
    ) : (
      <Money amount={Number(amount)} currency="CZK" locale={locale} />
    );
  const result = report?.result;
  const preview = result ? vatReturnPreviewData(result) : null;
  return (
    <>
      <AppSidebar currentCompanyId={companyId} activeReport />
      <main className="dashboard vat-reports">
        <header>
          <p className="iv-muted">{company.name}</p>
          <h1>{t("vatReports.title")}</h1>
          <p className="iv-muted">{t("vatReports.scope")}</p>
        </header>
        <section>
          <form
            className="form filters"
            aria-label={t("vatReports.selectPeriod")}
          >
            <TextField
              label={t("vatReports.period")}
              type="month"
              name="period"
              required
              min="2000-01"
              max="2099-12"
              defaultValue={period}
            />
            <Button type="submit" variant="secondary">
              {t("vatReports.show")}
            </Button>
          </form>
          <GenerateForm
            key={period}
            companyId={companyId}
            period={period}
            exists={!!report}
          />
        </section>
        {!report || !result || !preview ? (
          <EmptyState icon="report" title={t("vatReports.none")} />
        ) : (
          <>
            <section>
              <h2>{t("vatReports.draft", { period: preview.period })}</h2>
              <p>
                {preview.company.name} · {preview.company.vatId}
              </p>
              <p className="iv-muted">
                {preview.company.street}, {preview.company.postalCode}{" "}
                {preview.company.city}
              </p>
              <p className="iv-muted">
                {t("vatReports.generated", {
                  date: formatDocumentDate(report.generatedAt, true),
                })}
              </p>
              <p className="iv-muted">{t("vatReports.snapshot")}</p>
              <DataTable
                caption={t("vatReports.vatReturn")}
                rows={preview.lines.map((r) => ({ ...r, id: r.line }))}
                columns={[
                  {
                    key: "line",
                    header: t("vatReports.line"),
                    render: (r) => t(`vatReports.lines.${r.line}`),
                  },
                  {
                    key: "netAmount",
                    header: t("vatReports.netAmount"),
                    align: "right",
                    render: (r) => drilldown(r.netAmount, r.documentIds),
                  },
                  {
                    key: "vatAmount",
                    header: t("vatReports.vatAmount"),
                    align: "right",
                    render: (r) => drilldown(r.vatAmount, r.documentIds),
                  },
                ]}
              />
              <dl className="report-totals">
                {(
                  [
                    ["outputVat", result.totalDocumentIds.outputVat],
                    ["inputVat", result.totalDocumentIds.inputVat],
                    ["payable", result.totalDocumentIds.payable],
                    [
                      "excessDeduction",
                      result.totalDocumentIds.excessDeduction,
                    ],
                  ] as const
                ).map(([key, ids]) => (
                  <div key={key}>
                    <dt>{t(`vatReports.${key}`)}</dt>
                    <dd>{drilldown(preview.totals[key], [...ids])}</dd>
                  </div>
                ))}
              </dl>
              <a
                className="iv-btn iv-btn-secondary iv-btn-md"
                href={`/companies/${companyId}/vat-reports/${period}/pdf`}
                download={`DPHDP3-${period}.pdf`}
              >
                {t("vatReports.downloadPdf")}
              </a>
            </section>
            <section>
              <h2>{t("vatReports.controlStatement")}</h2>
              {result.controlStatement.length === 0 ? (
                <p>{t("vatReports.noEntries")}</p>
              ) : (
                result.controlStatement.map((entry, i) => (
                  <div className="report-section" key={`${entry.section}-${i}`}>
                    <h3>
                      {t("vatReports.section", { section: entry.section })}
                    </h3>
                    {entry.documentNumber && (
                      <p>
                        {entry.documentNumber} · {entry.counterpartyVatId} ·{" "}
                        {formatDocumentDate(entry.taxPointDate!)}
                        {entry.reverseChargeCode && (
                          <>
                            {" "}· {t("review.fields.reverseChargeCode")}{" "}
                            {entry.reverseChargeCode}
                          </>
                        )}
                      </p>
                    )}
                    <DataTable
                      caption={t("vatReports.section", {
                        section: entry.section,
                      })}
                      rows={entry.rateBreakdown.map((r) => ({
                        ...r,
                        id: String(r.rate),
                      }))}
                      columns={[
                        {
                          key: "rate",
                          header: t("review.fields.rate"),
                          render: (r) => t("vatReports.rate", { rate: r.rate }),
                        },
                        {
                          key: "netAmount",
                          header: t("vatReports.netAmount"),
                          align: "right",
                          render: (r) => drilldown(r.netAmount, r.documentIds),
                        },
                        {
                          key: "vatAmount",
                          header: t("vatReports.vatAmount"),
                          align: "right",
                          render: (r) => drilldown(r.vatAmount, r.documentIds),
                        },
                      ]}
                    />
                  </div>
                ))
              )}
            </section>
            <ExportForm
              key={report.id + report.generatedAt}
              companyId={companyId}
              period={period}
              preparedOn={new Intl.DateTimeFormat("sv-SE", {
                timeZone: "Europe/Prague",
              }).format(new Date())}
              personType={result.company.personType}
            />
            <section>
              <h2>{t("vatReports.excluded")}</h2>
              {result.excludedDocuments.length === 0 ? (
                <p>{t("vatReports.noExclusions")}</p>
              ) : (
                <ul>
                  {result.excludedDocuments.map((d) => (
                    <li key={d.documentId}>
                      {documentLink(d.documentId)} ·{" "}
                      {t(`vatReports.reasons.${d.reason}`)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}
